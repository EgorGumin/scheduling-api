import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { channels, platformCredentials, posts } from "../../db/schema.js";
import type { CommentProvider } from "../../platform/port.js";
import { PlatformError, type ChannelContext, type RawComment, type RawPost } from "../../platform/types.js";
import { projectComments, type ProjectionResult } from "./projector.js";

/** Consecutive failures after which the channel is reported as degraded. */
const DEGRADE_AFTER = 3;

const DEFAULT_MAX_POSTS = 40;

/** Share of a pass spent on the newest posts; the rest rotates by least-recently-checked. */
const RECENT_SHARE = 0.75;

/** Posts read at once within one channel. */
const FETCH_CONCURRENCY = 5;

export interface ReconcileOptions {
  /** Ignores each post's own position and reads it whole. */
  readonly full?: boolean;
  /** Caps the work of one pass, so a large channel does not starve the others. */
  readonly maxPosts?: number;
}

export interface ReconcileReport {
  readonly channelId: string;
  readonly postsChecked: number;
  readonly seen: number;
  readonly inserted: number;
  readonly updated: number;
  readonly failures: readonly { postExternalId: string; code: string }[];
  readonly durationMs: number;
}

/**
 * One pass over a channel: read the posts this pass can afford, project what came
 * back, move each post's position.
 */
export async function reconcileChannel(
  db: Database,
  provider: CommentProvider,
  channelId: string,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const startedAt = Date.now();
  const ctx = await loadChannel(db, channelId);

  const posts = await postsToCheck(db, channelId, options.maxPosts ?? DEFAULT_MAX_POSTS);
  const failures: { postExternalId: string; code: string }[] = [];
  const totals = { seen: 0, inserted: 0, updated: 0 };

  const checked: string[] = [];

  // Reads go five at a time because the round trip dominates; writes go one at a
  // time because linkOrphans touches the whole channel, and two projections at
  // once would block each other on the same rows.
  for (const batch of chunk(posts, FETCH_CONCURRENCY)) {
    const fetched = await Promise.all(
      batch.map(async (post) => {
        const since = options.full === true ? undefined : (post.readThrough ?? undefined);
        try {
          return { post, read: await readPost(provider, ctx, post.externalPostId, since) };
        } catch (error) {
          return { post, error };
        }
      }),
    );

    for (const result of fetched) {
      if ("error" in result) {
        // One unreadable post does not abandon the rest of the channel. Its own
        // position is left untouched, so the next pass asks from the same point
        // and nothing falls between them.
        failures.push({
          postExternalId: result.post.externalPostId,
          code: result.error instanceof PlatformError ? result.error.code : "unknown",
        });
        continue;
      }
      checked.push(result.post.id);
      if (result.read.post !== undefined) {
        await describePost(db, result.post.id, result.read.post);
      }
      accumulate(totals, await projectComments(db, ctx, result.post.id, result.read.items));
    }
  }

  const everythingFailed = failures.length > 0 && checked.length === 0;

  await markRead(db, checked);
  await recordPass(db, channelId, everythingFailed);

  return {
    channelId,
    postsChecked: checked.length,
    ...totals,
    failures,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Follows the platform's pagination to the end of the post: one page is the
 * newest fragment of a thread, not the thread.
 *
 * No page cap. A capped walk looks like a successful pass, the position moves,
 * and everything behind the last page read falls outside every later `since`
 * window. A long walk is only slow, and it ends when the platform stops handing
 * out cursors. An interrupted one restarts from the first page, which costs quota
 * and changes nothing: every page goes through the same idempotent upsert.
 */
async function readPost(
  provider: CommentProvider,
  ctx: ChannelContext,
  postExternalId: string,
  since: Date | undefined,
): Promise<{ items: RawComment[]; post?: RawPost }> {
  const items: RawComment[] = [];
  const seen = new Set<string>();
  let post: RawPost | undefined;
  let cursor: string | undefined;

  for (;;) {
    const result = await provider.listComments(ctx, {
      postExternalId,
      ...(since !== undefined && { since }),
      ...(cursor !== undefined && { cursor }),
    });

    items.push(...result.items);
    // Platforms that carry the post do it on the first page only.
    post ??= result.post;

    if (result.cursor === null) {
      break;
    }
    // A platform that hands back a cursor it already gave would otherwise keep
    // this loop going forever on its own bug.
    if (seen.has(result.cursor)) {
      throw new PlatformError("unknown", `${postExternalId}: pagination cursor repeated`, false);
    }
    seen.add(result.cursor);
    cursor = result.cursor;
  }

  return post === undefined ? { items } : { items, post };
}

/**
 * Keeps enough of the post to show what a comment answers. Platforms that carry
 * the post return it in the same call as the comments, so this costs no extra
 * round trip.
 */
async function describePost(db: Database, postId: string, post: RawPost): Promise<void> {
  await db
    .update(posts)
    // COALESCE rather than plain assignment: a later read that carries less than
    // the first one must not blank out what we already know.
    .set({
      preview: sql`COALESCE(${post.preview}::text, ${posts.preview})`,
      permalink: sql`COALESCE(${post.permalink}::text, ${posts.permalink})`,
      publishedAt: sql`COALESCE(${post.publishedAt?.toISOString() ?? null}::timestamptz, ${posts.publishedAt})`,
    })
    .where(eq(posts.id, postId));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function accumulate(
  totals: { seen: number; inserted: number; updated: number },
  result: ProjectionResult,
): void {
  totals.seen += result.seen;
  totals.inserted += result.inserted;
  totals.updated += result.updated;
}

async function loadChannel(db: Database, channelId: string): Promise<ChannelContext> {
  const rows = await db
    .select({
      channelId: channels.id,
      tenantId: channels.tenantId,
      platform: sql<ChannelContext["platform"]>`${channels.platform}`,
      subjectExternalId: channels.subjectExternalId,
      credentialRef: platformCredentials.credentialRef,
    })
    .from(channels)
    .leftJoin(platformCredentials, eq(platformCredentials.id, channels.credentialId))
    .where(eq(channels.id, channelId));

  const row = rows.at(0);
  if (row === undefined) {
    throw new Error(`unknown channel ${channelId}`);
  }
  return row;
}

interface PostToCheck {
  readonly id: string;
  readonly externalPostId: string;
  /** Comments older than this have already been read; NULL means none have. */
  readonly readThrough: Date | null;
}

/**
 * Most of the budget goes to the newest posts; the rest rotates through the others
 * oldest-read first, so an old post still comes round. Nothing retires a post here:
 * which ones are worth watching belongs to whoever registered them.
 */
async function postsToCheck(
  db: Database,
  channelId: string,
  limit: number,
): Promise<readonly PostToCheck[]> {
  const recent = Math.max(1, Math.round(limit * RECENT_SHARE));

  const rows = await db.execute<{
    id: string;
    external_post_id: string;
    comments_read_through: string | null;
  }>(sql`
    WITH recent AS (
      SELECT id, external_post_id, comments_read_through FROM posts
       WHERE channel_id = ${channelId}::uuid
       ORDER BY published_at DESC NULLS LAST, id DESC
       LIMIT ${recent}
    ),
    rotating AS (
      SELECT id, external_post_id, comments_read_through FROM posts
       WHERE channel_id = ${channelId}::uuid
         AND id NOT IN (SELECT id FROM recent)
       ORDER BY comments_read_through ASC NULLS FIRST, id
       LIMIT ${Math.max(0, limit - recent)}
    )
    SELECT id, external_post_id, comments_read_through FROM recent
    UNION ALL
    SELECT id, external_post_id, comments_read_through FROM rotating
  `);

  // Raw SQL returns timestamps as strings; `since` is compared against a Date.
  return rows.map((row) => ({
    id: row.id,
    externalPostId: row.external_post_id,
    readThrough:
      row.comments_read_through === null ? null : new Date(row.comments_read_through),
  }));
}

/**
 * Only posts read to the end move. The minute of overlap covers the gap between our
 * clock and the platform's. The position lives on the post: a pass reads a budgeted
 * subset, so a channel-wide one would speak for posts it never opened.
 */
async function markRead(db: Database, postIds: readonly string[]): Promise<void> {
  if (postIds.length === 0) {
    return;
  }
  await db
    .update(posts)
    .set({ commentsReadThrough: sql`now() - interval '1 minute'` })
    .where(inArray(posts.id, [...postIds]));
}

/**
 * Counts consecutive passes where every post failed, and moves the channel between
 * active and degraded.
 */
async function recordPass(
  db: Database,
  channelId: string,
  everythingFailed: boolean,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO sync_state (channel_id, last_reconcile_at, consecutive_failures)
    VALUES (${channelId}::uuid, now(), ${everythingFailed ? 1 : 0})
    ON CONFLICT (channel_id) DO UPDATE SET
      last_reconcile_at = now(),
      consecutive_failures = CASE WHEN ${everythingFailed} THEN sync_state.consecutive_failures + 1 ELSE 0 END
  `);

  // Only between active and degraded. A channel whose account was disconnected
  // stays disconnected: reads keep working without a credential on some
  // platforms, and a healthy pass is no evidence that the account came back.
  await db.execute(sql`
    UPDATE channels
       SET status = CASE
             WHEN s.consecutive_failures >= ${DEGRADE_AFTER} AND channels.status = 'active' THEN 'degraded'
             WHEN s.consecutive_failures < ${DEGRADE_AFTER} AND channels.status = 'degraded' THEN 'active'
             ELSE channels.status
           END,
           degraded_at = CASE
             WHEN s.consecutive_failures >= ${DEGRADE_AFTER} THEN COALESCE(channels.degraded_at, now())
             WHEN channels.status = 'degraded' THEN NULL
             ELSE channels.degraded_at
           END
      FROM sync_state s
     WHERE s.channel_id = channels.id AND channels.id = ${channelId}::uuid
  `);
}

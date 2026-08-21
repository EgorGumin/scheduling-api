import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import type { ChannelContext, RawComment } from "../../platform/types.js";

export interface ProjectionResult {
  readonly seen: number;
  readonly inserted: number;
  readonly updated: number;
  readonly linked: number;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** One call carries one post: a read asks the platform about a post and gets its thread back. */
export async function projectComments(
  db: Database,
  ctx: ChannelContext,
  postId: string,
  raw: readonly RawComment[],
): Promise<ProjectionResult> {
  if (raw.length === 0) {
    return { seen: 0, inserted: 0, updated: 0, linked: 0 };
  }

  return db.transaction(async (tx) => {
    let inserted = 0;
    let updated = 0;

    // One statement per comment, so a parent earlier in the batch is already
    // visible to its children. Batching means sorting the batch into levels
    // first; at one post's worth of comments per call the round trips cost less.
    for (const comment of raw) {
      const outcome = await upsertComment(tx, ctx, comment, postId);
      if (outcome === "inserted") {
        inserted += 1;
      } else if (outcome === "updated") {
        updated += 1;
      }
    }

    const linked = await linkOrphans(tx, ctx.channelId);
    await seedCommentStates(tx, ctx, raw.map((comment) => comment.externalId));

    return { seen: raw.length, inserted, updated, linked };
  });
}

async function upsertComment(
  tx: Tx,
  ctx: ChannelContext,
  comment: RawComment,
  postId: string,
): Promise<"inserted" | "updated" | "skipped"> {
  const media = comment.media.length === 0 ? null : JSON.stringify(comment.media);

  const rows = await tx.execute<{ inserted: boolean }>(sql`
    WITH parent AS (
      SELECT id, depth FROM comments
       WHERE channel_id = ${ctx.channelId}::uuid
         AND external_id = ${comment.parentExternalId}
    ),
    echo AS (
      SELECT 1 FROM outbound_replies
       WHERE channel_id = ${ctx.channelId}::uuid
         AND external_id = ${comment.externalId}
    )
    INSERT INTO comments (
      tenant_id, channel_id, post_id, external_id, parent_external_id, parent_id,
      depth, author_external_id, author_display_name, author_handle, body, media,
      is_outbound, lifecycle, reply_disabled, created_at_remote, edited_at_remote,
      remote_version, first_seen_at, last_synced_at
    )
    SELECT ${ctx.tenantId}::uuid, ${ctx.channelId}::uuid, ${postId}::uuid,
           ${comment.externalId}, ${comment.parentExternalId},
           (SELECT id FROM parent),
           COALESCE((SELECT depth FROM parent) + 1, 0),
           ${comment.author?.externalId ?? null},
           ${comment.author?.displayName ?? null},
           ${comment.author?.handle ?? null},
           ${comment.body}, ${media}::jsonb,
           EXISTS (SELECT 1 FROM echo),
           ${comment.lifecycle},
           COALESCE(${comment.replyDisabled}::boolean, false),
           ${comment.createdAtRemote.toISOString()}::timestamptz,
           ${comment.editedAtRemote?.toISOString() ?? null}::timestamptz,
           ${comment.remoteVersion?.toISOString() ?? null}::timestamptz,
           now(), now()
    ON CONFLICT (channel_id, external_id) DO UPDATE SET
      body = excluded.body,
      author_external_id = excluded.author_external_id,
      author_display_name = excluded.author_display_name,
      author_handle = excluded.author_handle,
      media = excluded.media,
      -- Set at insert, but our own reply can be read back before delivery has
      -- recorded its external id, and the next pass is where that shows up.
      is_outbound = comments.is_outbound OR excluded.is_outbound,
      lifecycle = excluded.lifecycle,
      reply_disabled = excluded.reply_disabled,
      edited_at_remote = excluded.edited_at_remote,
      remote_version = excluded.remote_version,
      last_synced_at = now(),
      parent_external_id = excluded.parent_external_id
    WHERE
      comments.remote_version IS NULL
      OR excluded.remote_version IS NULL
      OR excluded.remote_version >= comments.remote_version
    RETURNING (xmax = 0) AS inserted
  `);

  const row = rows.at(0);
  if (row === undefined) {
    return "skipped";
  }
  return row.inserted ? "inserted" : "updated";
}

/**
 * Fills in parent_id once the parent is stored, matching on the platform's reference
 * recorded at insert: nothing guarantees a parent arrives before its children. One
 * statement covers a chain, because the match does not depend on the parent being
 * linked itself.
 */
async function linkOrphans(tx: Tx, channelId: string): Promise<number> {
  const attached = await tx.execute<{ id: string }>(sql`
    UPDATE comments AS child
       SET parent_id = parent.id
      FROM comments AS parent
     WHERE child.channel_id = ${channelId}::uuid
       AND child.parent_id IS NULL
       AND child.parent_external_id IS NOT NULL
       AND parent.channel_id = child.channel_id
       AND parent.external_id = child.parent_external_id
       AND parent.id <> child.id
    RETURNING child.id
  `);

  if (attached.length > 0) {
    await recomputeDepth(tx, channelId);
  }

  return attached.length;
}

/**
 * Attaching a parent shifts its whole subtree, so depth is recomputed rather than
 * only set at insert. The walk covers the channel because finding the affected
 * subtrees costs the same walk. Depth is what `maxDepth` is checked against before
 * a reply is queued.
 */
async function recomputeDepth(tx: Tx, channelId: string): Promise<void> {
  await tx.execute(sql`
    WITH RECURSIVE tree AS (
      SELECT id, 0 AS depth FROM comments
       WHERE channel_id = ${channelId}::uuid AND parent_id IS NULL
      UNION ALL
      SELECT c.id, t.depth + 1
        FROM comments c JOIN tree t ON c.parent_id = t.id
       WHERE c.channel_id = ${channelId}::uuid
    )
    UPDATE comments SET depth = tree.depth
      FROM tree
     WHERE comments.id = tree.id AND comments.depth <> tree.depth
  `);
}

/** The inbox triages what other people wrote, so our own replies get no state row. */
async function seedCommentStates(
  tx: Tx,
  ctx: ChannelContext,
  externalIds: readonly string[],
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO comment_states (comment_id, tenant_id, ingest_seq, updated_at)
    SELECT c.id, c.tenant_id, c.ingest_seq, now()
      FROM comments c
     WHERE c.channel_id = ${ctx.channelId}::uuid
       AND c.external_id = ANY(${sql.param([...externalIds])}::text[])
       AND c.is_outbound = false
    ON CONFLICT (comment_id) DO NOTHING
  `);
}

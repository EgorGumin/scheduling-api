import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { channels, posts } from "../db/schema.js";
import type { Handling } from "../domain/triage.js";
import {
  resolveAction,
  type Action,
  type CredentialState,
  type PlatformManifest,
} from "../platform/capabilities.js";
import type { Lifecycle, MediaRef, Platform } from "../platform/types.js";
import { encodeId } from "./ids.js";

export interface InboxFilter {
  readonly tenantId: string;
  readonly channelId?: string;
  readonly postIds?: readonly string[];
  readonly publisherPostIds?: readonly string[];
  readonly handling?: readonly Handling[];
  readonly direction?: "inbound" | "outbound";
  readonly lifecycle?: readonly Lifecycle[];
  readonly limit: number;
  readonly cursor?: string;
}

export interface CommentView {
  id: string;
  channelId: string;
  postId: string;
  platform: Platform;
  parentId: string | null;
  depth: number;
  author: { id: string; displayName: string | null; handle: string | null } | null;
  body: string | null;
  media: readonly MediaRef[];
  direction: "inbound" | "outbound";
  lifecycle: Lifecycle;
  createdAt: string;
  editedAt: string | null;
  firstSeenAt: string;
  /** Ours, not the platform's. `null` on a reply we sent: triage does not apply to it. */
  state: {
    handling: Handling;
    handledAt: string | null;
    handledBy: string | null;
    note: string | null;
  } | null;
  actions: { reply: Action };
  replyIds: readonly string[];
}

type Row = {
  id: string;
  channel_id: string;
  post_id: string;
  platform: Platform;
  parent_id: string | null;
  depth: number;
  author_external_id: string | null;
  author_display_name: string | null;
  author_handle: string | null;
  body: string | null;
  media: MediaRef[] | null;
  is_outbound: boolean;
  lifecycle: Lifecycle;
  reply_disabled: boolean;
  created_at_remote: string;
  edited_at_remote: string | null;
  first_seen_at: string;
  ingest_seq: string;
  handling: Handling | null;
  handled_at: string | null;
  handled_by: string | null;
  note: string | null;
  credential_state: CredentialState | null;
  granted_scopes: string[] | null;
  reply_ids: string[] | null;
};

/** Side-loaded so a hundred comments on one post do not repeat it a hundred times. */
export interface PostRef {
  readonly id: string;
  readonly preview: string | null;
  readonly permalink: string | null;
  readonly publishedAt: string | null;
  readonly publisherPostId: string | null;
}

export interface InboxPage {
  readonly items: readonly CommentView[];
  readonly posts: readonly PostRef[];
  readonly nextCursor: string | null;
}

const PROJECTION = sql`
    SELECT c.id, c.channel_id, c.post_id, ch.platform,
           c.parent_id, c.depth, c.author_external_id, c.author_display_name,
           c.author_handle, c.body, c.media, c.is_outbound, c.lifecycle, c.reply_disabled,
           c.created_at_remote, c.edited_at_remote, c.first_seen_at,
           c.ingest_seq::text AS ingest_seq,
           s.handling, s.handled_at, s.handled_by, s.note,
           pc.state AS credential_state, pc.granted_scopes,
           ARRAY(SELECT r.id::text FROM outbound_replies r
                  WHERE r.in_reply_to_comment_id = c.id) AS reply_ids
      FROM comments c
      JOIN channels ch ON ch.id = c.channel_id
      -- Joined for the publisher_post_id filter; the post itself is side-loaded.
      JOIN posts p ON p.id = c.post_id
      LEFT JOIN comment_states s ON s.comment_id = c.id
      LEFT JOIN platform_credentials pc ON pc.id = ch.credential_id`;

/**
 * One page of the inbox, ordered by the ingest counter rather than by the
 * platform's creation time: a comment the platform indexed late is stored now
 * with an old creation time, and ordering by creation would file it below a
 * cursor the client has already passed.
 */
export async function listComments(
  db: Database,
  manifests: Readonly<Record<string, PlatformManifest>>,
  filter: InboxFilter,
  now: Date = new Date(),
): Promise<InboxPage> {
  const after = filter.cursor === undefined ? null : decodeCursor(filter.cursor);

  const rows = await db.execute<Row>(sql`
    ${PROJECTION}
     WHERE c.tenant_id = ${filter.tenantId}::uuid
       AND (${filter.channelId ?? null}::uuid IS NULL OR c.channel_id = ${filter.channelId ?? null}::uuid)
       AND (${jsonOrNull(filter.postIds)}::jsonb IS NULL
            OR c.post_id IN (SELECT (jsonb_array_elements_text(${jsonOrNull(filter.postIds)}::jsonb))::uuid))
       AND (${jsonOrNull(filter.publisherPostIds)}::jsonb IS NULL
            OR p.publisher_post_id IN (
                 SELECT jsonb_array_elements_text(${jsonOrNull(filter.publisherPostIds)}::jsonb)))
       AND (${jsonOrNull(filter.handling)}::jsonb IS NULL
            OR s.handling IN (SELECT jsonb_array_elements_text(${jsonOrNull(filter.handling)}::jsonb)))
       AND (${jsonOrNull(filter.lifecycle)}::jsonb IS NULL
            OR c.lifecycle IN (SELECT jsonb_array_elements_text(${jsonOrNull(filter.lifecycle)}::jsonb)))
       AND (${filter.direction ?? null}::text IS NULL
            OR c.is_outbound = (${filter.direction ?? null}::text = 'outbound'))
       AND (${after}::bigint IS NULL OR c.ingest_seq < ${after}::bigint)
     ORDER BY c.ingest_seq DESC
     LIMIT ${filter.limit + 1}
  `);

  const page = rows.slice(0, filter.limit);
  // The extra row we asked for came back, so there is a page after this one.
  const last = rows.length > filter.limit ? page.at(-1) : undefined;

  return {
    items: page.map((row) => toView(row, manifests, now)),
    posts: await postsFor(db, page),
    nextCursor: last === undefined ? null : encodeCursor(last.ingest_seq),
  };
}

async function postsFor(db: Database, rows: readonly Row[]): Promise<PostRef[]> {
  const ids = [...new Set(rows.map((row) => row.post_id))];
  if (ids.length === 0) {
    return [];
  }

  const found = await db
    .select({
      id: posts.id,
      preview: posts.preview,
      permalink: posts.permalink,
      publishedAt: posts.publishedAt,
      publisherPostId: posts.publisherPostId,
    })
    .from(posts)
    .where(inArray(posts.id, ids));

  return found.map((post) => ({
    ...post,
    id: encodeId("post", post.id),
    publishedAt: post.publishedAt?.toISOString() ?? null,
  }));
}

export async function getComment(
  db: Database,
  manifests: Readonly<Record<string, PlatformManifest>>,
  tenantId: string,
  commentId: string,
  now: Date = new Date(),
): Promise<CommentView | null> {
  const rows = await db.execute<Row>(sql`
    ${PROJECTION}
     WHERE c.tenant_id = ${tenantId}::uuid AND c.id = ${commentId}::uuid
  `);

  const row = rows.at(0);
  return row === undefined ? null : toView(row, manifests, now);
}

function toView(
  row: Row,
  manifests: Readonly<Record<string, PlatformManifest>>,
  now: Date,
): CommentView {
  const manifest = manifests[row.platform];
  const action: Action =
    manifest === undefined
      ? { status: "unsupported" }
      : resolveAction(
          manifest,
          {
            credential:
              row.credential_state === null
                ? null
                : { state: row.credential_state, grantedScopes: row.granted_scopes },
          },
          {
            createdAtRemote: new Date(row.created_at_remote),
            lifecycle: row.lifecycle,
            replyDisabled: row.reply_disabled,
          },
          now,
        );

  return {
    id: encodeId("comment", row.id),
    channelId: encodeId("channel", row.channel_id),
    postId: encodeId("post", row.post_id),
    platform: row.platform,
    parentId: row.parent_id === null ? null : encodeId("comment", row.parent_id),
    depth: row.depth,
    author:
      row.author_external_id === null
        ? null
        : {
            id: row.author_external_id,
            displayName: row.author_display_name,
            handle: row.author_handle,
          },
    body: row.body,
    media: row.media ?? [],
    direction: row.is_outbound ? "outbound" : "inbound",
    lifecycle: row.lifecycle,
    createdAt: iso(row.created_at_remote)!,
    editedAt: iso(row.edited_at_remote),
    firstSeenAt: iso(row.first_seen_at)!,
    // Our own reply read back before delivery recorded its external id arrives
    // as an ordinary comment, and the projector seeds a state row for it. The
    // row stays after the next pass marks the comment ours; it is never shown.
    state:
      row.is_outbound || row.handling === null
        ? null
        : {
            handling: row.handling,
            handledAt: iso(row.handled_at),
            handledBy: row.handled_by,
            note: row.note,
          },
    actions: { reply: action },
    replyIds: (row.reply_ids ?? []).map((id) => encodeId("reply", id)),
  };
}

function iso(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function jsonOrNull(values: readonly string[] | undefined): string | null {
  return values === undefined || values.length === 0 ? null : JSON.stringify(values);
}

function encodeCursor(ingestSeq: string): string {
  return Buffer.from(`seq:${ingestSeq}`, "utf8").toString("base64url");
}

/** `null` for a cursor we did not issue. Base64 decoding accepts anything, so check the format. */
export function decodeCursor(cursor: string): string | null {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  return /^seq:(\d+)$/.exec(decoded)?.[1] ?? null;
}

/** `null` when the channel is not this tenant's, which reads the same as absent. */
export async function channelPlatform(
  db: Database,
  tenantId: string,
  channelId: string,
): Promise<Platform | null> {
  const rows = await db
    .select({ platform: sql<Platform>`${channels.platform}` })
    .from(channels)
    .where(and(eq(channels.tenantId, tenantId), eq(channels.id, channelId)));

  return rows.at(0)?.platform ?? null;
}

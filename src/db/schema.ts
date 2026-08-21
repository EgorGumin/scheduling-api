import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const tstz = (name: string) => timestamp(name, { withTimezone: true });
const newId = () => uuid().primaryKey().default(sql`uuidv7()`);

/**
 * Owned by the account-connection module, not by this one. Present here so the
 * comment flow is runnable end to end; we read it and may only downgrade `state`.
 */
export const platformCredentials = pgTable(
  "platform_credentials",
  {
    id: newId(),
    tenantId: uuid().notNull(),
    platform: text().notNull(),
    /**
     * The account this credential speaks as. Serves as the login identifier, and
     * as the author id that marks a comment ours when it was written outside this
     * system. NULL until a connection has established it.
     */
    actorExternalId: text(),
    credentialRef: text().notNull(),
    expiresAt: tstz("expires_at"),
    /** NULL means the platform does not report scope composition. */
    grantedScopes: text().array(),
    /** ok | expired | insufficient_scope | revoked */
    state: text().notNull().default("ok"),
    stateChangedAt: tstz("state_changed_at"),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    // Platform is in the key so a channel cannot borrow another platform's account
    unique().on(t.tenantId, t.platform, t.id),
    check("credential_state", sql`${t.state} IN ('ok', 'expired', 'insufficient_scope', 'revoked')`),
  ],
);

/** The observed subject on a platform: a page, profile or channel. */
export const channels = pgTable(
  "channels",
  {
    id: newId(),
    tenantId: uuid().notNull(),
    platform: text().notNull(),
    subjectExternalId: text().notNull(),
    subjectName: text(),
    subjectHandle: text(),
    /** NULL means read-only: the channel is watched without credentials. */
    credentialId: uuid(),
    /** active | degraded | disconnected. `disconnected` is written by whoever owns the account. */
    status: text().notNull().default("active"),
    degradedAt: tstz("degraded_at"),
    /** Nothing is captured before this point; historical import is out of scope. */
    captureStartedAt: tstz("capture_started_at"),
  },
  (t) => [
    unique().on(t.tenantId, t.platform, t.subjectExternalId),
    unique().on(t.tenantId, t.id),
    foreignKey({
      name: "channel_credential_same_tenant_and_platform",
      columns: [t.tenantId, t.platform, t.credentialId],
      foreignColumns: [
        platformCredentials.tenantId,
        platformCredentials.platform,
        platformCredentials.id,
      ],
    }),
    index().on(t.credentialId),
    check("channel_status", sql`${t.status} IN ('active', 'degraded', 'disconnected')`),
  ],
);

export const posts = pgTable(
  "posts",
  {
    id: newId(),
    tenantId: uuid().notNull(),
    channelId: uuid().notNull(),
    /** Always present: it arrives with every ingested event. */
    externalPostId: text().notNull(),
    /** Only for posts we published ourselves. */
    publisherPostId: text(),
    publishedAt: tstz("published_at"),
    permalink: text(),
    /** Enough of the post to know what a comment is answering. */
    preview: text(),
    /** Comments older than this have been read. NULL means the post never has been. */
    commentsReadThrough: tstz("comments_read_through"),
  },
  (t) => [
    unique().on(t.channelId, t.externalPostId),
    unique().on(t.tenantId, t.id),
    unique().on(t.tenantId, t.channelId, t.id),
    foreignKey({
      name: "post_channel_same_tenant",
      columns: [t.tenantId, t.channelId],
      foreignColumns: [channels.tenantId, channels.id],
    }),
    index().on(t.publisherPostId).where(sql`publisher_post_id IS NOT NULL`),
  ],
);

/**
 * Local projection of the platform's comments. Rebuilt by a sync; our own
 * decisions live in `comment_states`.
 */
export const comments = pgTable(
  "comments",
  {
    id: newId(),
    tenantId: uuid().notNull(),
    channelId: uuid().notNull(),
    postId: uuid().notNull(),
    externalId: text().notNull(),
    /** Always recorded; the internal link below is resolved once the parent arrives. */
    parentExternalId: text(),
    parentId: uuid(),
    /** Distance from the top of the thread. 0 while the parent is unresolved. */
    depth: smallint().notNull().default(0),
    authorExternalId: text(),
    authorDisplayName: text(),
    authorHandle: text(),
    body: text(),
    /** References and alt text only; no binaries are stored. */
    media: jsonb(),
    isOutbound: boolean().notNull().default(false),
    /** active | hidden | deleted | unknown */
    lifecycle: text().notNull().default("active"),
    /** The author or the thread owner has closed this object to replies. */
    replyDisabled: boolean().notNull().default(false),
    createdAtRemote: tstz("created_at_remote").notNull(),
    editedAtRemote: tstz("edited_at_remote"),
    /** The platform's own version of this object; decides which read wins. */
    remoteVersion: tstz("remote_version"),
    firstSeenAt: tstz("first_seen_at").notNull(),
    /** Inbox ordering: assigned at insert, immune to platform clocks. */
    ingestSeq: bigserial({ mode: "bigint" }).notNull(),
    lastSyncedAt: tstz("last_synced_at").notNull(),
  },
  (t) => [
    unique().on(t.ingestSeq),
    unique().on(t.tenantId, t.id),
    unique().on(t.tenantId, t.channelId, t.id),
    unique().on(t.channelId, t.externalId),
    // The post must belong to the same channel as the comment.
    foreignKey({
      name: "comment_post_in_same_channel",
      columns: [t.tenantId, t.channelId, t.postId],
      foreignColumns: [posts.tenantId, posts.channelId, posts.id],
    }),
    // The parent must be in the same channel too. A null parent_id passes, so a
    // child can arrive before the parent it points at.
    foreignKey({
      name: "comment_parent",
      columns: [t.tenantId, t.channelId, t.parentId],
      foreignColumns: [t.tenantId, t.channelId, t.id],
    }),
    index().on(t.tenantId, t.ingestSeq),
    index().on(t.channelId, t.ingestSeq),
    index().on(t.postId, t.createdAtRemote.desc(), t.id),
    // Cheaper than an enum type and edited by an ordinary migration, which is
    // what the vocabularies here need as platforms are added.
    check("comment_lifecycle", sql`${t.lifecycle} IN ('active', 'hidden', 'deleted', 'unknown')`),
    check("comment_depth_non_negative", sql`${t.depth} >= 0`),
  ],
);

/** What we decided about a comment. Written when someone acts on it */
export const commentStates = pgTable(
  "comment_states",
  {
    commentId: uuid().primaryKey(),
    tenantId: uuid().notNull(),
    /** new | answered | escalated | ignored */
    handling: text().notNull().default("new"),
    handledAt: tstz("handled_at"),
    /** Opaque actor id; its kind belongs to the identity service. */
    handledBy: text(),
    note: text(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "state_comment_same_tenant",
      columns: [t.tenantId, t.commentId],
      foreignColumns: [comments.tenantId, comments.id],
    }).onDelete("cascade"),
    check("state_handling", sql`${t.handling} IN ('new', 'answered', 'escalated', 'ignored')`),
    // An unhandled comment carries no record of having been handled.
    check(
      "state_new_is_unhandled",
      sql`${t.handling} <> 'new' OR (${t.handledAt} IS NULL AND ${t.handledBy} IS NULL)`,
    ),
  ],
);

export const outboundReplies = pgTable(
  "outbound_replies",
  {
    id: newId(),
    tenantId: uuid().notNull(),
    inReplyToCommentId: uuid().notNull(),
    channelId: uuid().notNull(),
    idempotencyKey: text().notNull(),
    requestedBy: text(),
    body: text().notNull(),
    /**
     * Business outcome only; attempts and backoff belong to the worker.
     *
     * queued | sending | retrying | posted | failed | expired
     */
    status: text().notNull().default("queued"),
    externalId: text(),
    postedAt: tstz("posted_at"),
    errorCode: text(),
    errorDetail: jsonb(),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    unique().on(t.tenantId, t.idempotencyKey),
    // The reply leaves through the same channel the comment belongs to.
    foreignKey({
      name: "reply_comment_in_same_channel",
      columns: [t.tenantId, t.channelId, t.inReplyToCommentId],
      foreignColumns: [comments.tenantId, comments.channelId, comments.id],
    }),
    index().on(t.inReplyToCommentId),
    check(
      "reply_status",
      sql`${t.status} IN ('queued', 'sending', 'retrying', 'posted', 'failed', 'expired')`,
    ),
  ],
);

export const syncState = pgTable("sync_state", {
  channelId: uuid()
    .primaryKey()
    .references(() => channels.id),
  lastReconcileAt: tstz("last_reconcile_at"),
  consecutiveFailures: smallint().notNull().default(0),
});

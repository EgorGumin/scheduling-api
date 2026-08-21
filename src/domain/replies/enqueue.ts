import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { channels, comments, outboundReplies, platformCredentials } from "../../db/schema.js";
import {
  resolveAction,
  type Action,
  type CredentialState,
  type PlatformManifest,
  type TextUnit,
} from "../../platform/capabilities.js";
import type { Lifecycle } from "../../platform/types.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const MAX_DELIVERY_ATTEMPTS = 8;

export interface ReplyRequest {
  readonly tenantId: string;
  readonly commentId: string;
  readonly idempotencyKey: string;
  readonly body: string;
  readonly requestedBy: string | null;
}

export type EnqueueResult =
  | { readonly outcome: "queued" | "duplicate"; readonly replyId: string }
  | { readonly outcome: "rejected"; readonly reason: RejectionReason; readonly action?: Action }
  | { readonly outcome: "unknown_comment" };

export type RejectionReason =
  | "action_unavailable"
  | "body_too_long"
  | "body_empty"
  | "depth_exceeded"
  | "idempotency_conflict";

type CommentRow = {
  id: string;
  channel_id: string;
  platform: PlatformManifest["platform"];
  depth: number;
  lifecycle: Lifecycle;
  reply_disabled: boolean;
  created_at_remote: Date;
  credential_state: CredentialState | null;
  granted_scopes: string[] | null;
};

/** Queues a reply and the job that will deliver it in one transaction. */
export async function enqueueReply(
  db: Database,
  manifests: Readonly<Record<string, PlatformManifest>>,
  request: ReplyRequest,
  now: Date = new Date(),
): Promise<EnqueueResult> {
  // A key we have already accepted is answered as it was recorded: the reply may
  // be sent by now, and the checks below could refuse what we accepted.
  const accepted = await findByKey(db, request.tenantId, request.idempotencyKey);
  if (accepted !== null) {
    return sameCommand(accepted, request)
      ? { outcome: "duplicate", replyId: accepted.id }
      : { outcome: "rejected", reason: "idempotency_conflict" };
  }

  const comment = await loadComment(db, request.tenantId, request.commentId);
  if (comment === null) {
    return { outcome: "unknown_comment" };
  }

  const manifest = manifests[comment.platform];
  if (manifest === undefined) {
    return { outcome: "rejected", reason: "action_unavailable" };
  }

  const action = resolveAction(
    manifest,
    {
      credential:
        comment.credential_state === null
          ? null
          : { state: comment.credential_state, grantedScopes: comment.granted_scopes },
    },
    {
      createdAtRemote: comment.created_at_remote,
      lifecycle: comment.lifecycle,
      // As last observed by a read of the object; a stale "allowed" is corrected
      // by the platform rejecting the call.
      replyDisabled: comment.reply_disabled,
    },
    now,
  );
  if (action.status !== "available") {
    return { outcome: "rejected", reason: "action_unavailable", action };
  }

  const rejection = checkShape(manifest, comment, request.body);
  if (rejection !== null) {
    return { outcome: "rejected", reason: rejection };
  }

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(outboundReplies)
      .values({
        tenantId: request.tenantId,
        inReplyToCommentId: comment.id,
        channelId: comment.channel_id,
        idempotencyKey: request.idempotencyKey,
        requestedBy: request.requestedBy,
        body: request.body,
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: [outboundReplies.tenantId, outboundReplies.idempotencyKey] })
      .returning({ id: outboundReplies.id });

    const row = inserted.at(0);
    if (row === undefined) {
      // Two identical requests raced past the lookup above; the unique key decided
      // which one owns the reply and this is the other.
      const prior = await findByKey(tx, request.tenantId, request.idempotencyKey);
      if (prior === null || !sameCommand(prior, request)) {
        return { outcome: "rejected", reason: "idempotency_conflict" } as const;
      }
      return { outcome: "duplicate", replyId: prior.id } as const;
    }

    await tx.execute(sql`
      SELECT graphile_worker.add_job(
        'deliver-reply',
        payload := ${JSON.stringify({ replyId: row.id })}::json,
        max_attempts := ${MAX_DELIVERY_ATTEMPTS},
        job_key := ${`reply:${row.id}`}
      )
    `);

    return { outcome: "queued", replyId: row.id } as const;
  });
}

type AcceptedCommand = { id: string; body: string; in_reply_to_comment_id: string };

/**
 * A key reused for different content is a client bug, and silently returning the
 * earlier reply would hide it.
 */
function sameCommand(accepted: AcceptedCommand, request: ReplyRequest): boolean {
  return accepted.body === request.body && accepted.in_reply_to_comment_id === request.commentId;
}

async function findByKey(
  db: Database | Tx,
  tenantId: string,
  idempotencyKey: string,
): Promise<AcceptedCommand | null> {
  const rows = await db
    .select({
      id: outboundReplies.id,
      body: outboundReplies.body,
      in_reply_to_comment_id: outboundReplies.inReplyToCommentId,
    })
    .from(outboundReplies)
    .where(
      and(
        eq(outboundReplies.tenantId, tenantId),
        eq(outboundReplies.idempotencyKey, idempotencyKey),
      ),
    );
  return rows.at(0) ?? null;
}

function checkShape(
  manifest: PlatformManifest,
  comment: CommentRow,
  body: string,
): RejectionReason | null {
  const op = manifest.operations.reply;
  if (!op.supported) {
    return "action_unavailable";
  }
  if (body.trim().length === 0) {
    return "body_empty";
  }
  if (measure(body, op.text.counts) > op.text.maxLength) {
    return "body_too_long";
  }
  // A separate cap where the platform publishes one: 300 emoji are 300 graphemes
  // and far more than 3000 bytes, and only the platform would notice.
  if (op.text.maxBytes !== null && new TextEncoder().encode(body).length > op.text.maxBytes) {
    return "body_too_long";
  }
  if (op.maxDepth !== null && comment.depth + 1 > op.maxDepth) {
    return "depth_exceeded";
  }
  return null;
}

/** In the unit the platform counts in, which it declares rather than us assuming. */
function measure(body: string, unit: TextUnit): number {
  return unit === "graphemes" ? [...new Intl.Segmenter().segment(body)].length : body.length;
}

async function loadComment(
  db: Database,
  tenantId: string,
  commentId: string,
): Promise<CommentRow | null> {
  const rows = await db
    .select({
      id: comments.id,
      channel_id: comments.channelId,
      platform: sql<CommentRow["platform"]>`${channels.platform}`,
      depth: comments.depth,
      lifecycle: sql<Lifecycle>`${comments.lifecycle}`,
      reply_disabled: comments.replyDisabled,
      created_at_remote: comments.createdAtRemote,
      credential_state: sql<CredentialState | null>`${platformCredentials.state}`,
      granted_scopes: platformCredentials.grantedScopes,
    })
    .from(comments)
    .innerJoin(channels, eq(channels.id, comments.channelId))
    .leftJoin(platformCredentials, eq(platformCredentials.id, channels.credentialId))
    .where(and(eq(comments.tenantId, tenantId), eq(comments.id, commentId)));

  return rows.at(0) ?? null;
}

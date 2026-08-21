import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { channels, commentStates, comments, outboundReplies, platformCredentials } from "../../db/schema.js";
import type { ProviderRegistry } from "../../platform/port.js";
import type { CredentialState } from "../../platform/capabilities.js";
import { PlatformError, type ChannelContext, type PlatformErrorCode } from "../../platform/types.js";

/**
 * A refusal about the account concerns every comment on the channel. Left at `ok`,
 * the credential keeps advertising the action, and every later attempt spends a
 * platform call to learn the same thing. Only downgrades happen here; restoring
 * one belongs to the connection module.
 */
const DOWNGRADE: Partial<Record<PlatformErrorCode, CredentialState>> = {
  unauthorized: "revoked",
  permission_denied: "insufficient_scope",
};

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DeliverPayload {
  readonly replyId: string;
}

export interface AttemptInfo {
  /** 1 for the first run; graphile-worker counts before invoking the task. */
  readonly attempt: number;
  readonly maxAttempts: number;
}

type ReplyRow = {
  id: string;
  tenant_id: string;
  channel_id: string;
  in_reply_to_comment_id: string;
  body: string;
  status: string;
  requested_by: string | null;
  parent_external_id: string;
  platform: ChannelContext["platform"];
  subject_external_id: string;
  credential_id: string | null;
  credential_ref: string | null;
};

/**
 * Delivers one queued reply. A throw makes graphile-worker retry the job, a normal
 * return ends it, so a permanent rejection must not throw.
 */
export async function deliverReply(
  db: Database,
  providers: ProviderRegistry,
  payload: DeliverPayload,
  attempt: AttemptInfo,
): Promise<void> {
  const reply = await loadReply(db, payload.replyId);
  if (reply === null || isTerminal(reply.status)) {
    return;
  }

  // Checked before the row says `sending`: the registry raises a plain Error, so
  // discovering this later would retry until the job dies with the reply stuck in
  // that status.
  if (!providers.has(reply.platform)) {
    const missing = new PlatformError("unavailable", `no adapter for ${reply.platform}`, false);
    await recordFailure(db, reply, missing, attempt);
    return;
  }

  await setStatus(db, reply.id, "sending");

  const provider = providers.get(reply.platform);
  const ctx: ChannelContext = {
    channelId: reply.channel_id,
    tenantId: reply.tenant_id,
    platform: reply.platform,
    subjectExternalId: reply.subject_external_id,
    credentialRef: reply.credential_ref,
  };

  let posted;
  try {
    posted = await provider.postReply(ctx, {
      parentExternalId: reply.parent_external_id,
      body: reply.body,
    });
  } catch (error) {
    await recordFailure(db, reply, error, attempt);
    if (error instanceof PlatformError && error.retryable && attempt.attempt < attempt.maxAttempts) {
      throw error;
    }
    return;
  }

  // The reply's result and the comment's handling are one fact: it was answered
  // by this reply. They are written as one.
  await db.transaction(async (tx) => {
    await tx
      .update(outboundReplies)
      .set({
        status: "posted",
        externalId: posted.externalId,
        postedAt: posted.postedAt,
        errorCode: null,
        errorDetail: null,
      })
      .where(eq(outboundReplies.id, reply.id));
    await markAnswered(tx, reply);
  });
}

function isTerminal(status: string): boolean {
  return status === "posted" || status === "failed" || status === "expired";
}

async function setStatus(db: Database, replyId: string, status: string): Promise<void> {
  await db.update(outboundReplies).set({ status }).where(eq(outboundReplies.id, replyId));
}

async function recordFailure(
  db: Database,
  reply: ReplyRow,
  error: unknown,
  attempt: AttemptInfo,
): Promise<void> {
  const platformError = error instanceof PlatformError ? error : null;
  const code = platformError?.code ?? "unknown";
  const retryable = platformError?.retryable ?? false;
  const exhausted = attempt.attempt >= attempt.maxAttempts;

  const status =
    code === "window_expired" ? "expired" : retryable && !exhausted ? "retrying" : "failed";

  // The failure and what it says about the credential are one fact, written as one.
  await db.transaction(async (tx) => {
    await tx
      .update(outboundReplies)
      .set({
        status,
        errorCode: code,
        errorDetail: {
          message: error instanceof Error ? error.message : String(error),
          attempt: attempt.attempt,
          maxAttempts: attempt.maxAttempts,
        },
      })
      .where(eq(outboundReplies.id, reply.id));

    const downgrade = DOWNGRADE[code];
    if (downgrade !== undefined && reply.credential_id !== null) {
      await tx
        .update(platformCredentials)
        .set({ state: downgrade, stateChangedAt: new Date() })
        .where(
          and(
            eq(platformCredentials.id, reply.credential_id),
            // Only from `ok`: a credential already revoked or expired keeps that,
            // instead of being relabelled by a later refusal.
            eq(platformCredentials.state, "ok"),
          ),
        );
    }
  });
}

async function markAnswered(tx: Tx, reply: ReplyRow): Promise<void> {
  await tx
    .update(commentStates)
    .set({
      handling: "answered",
      handledAt: new Date(),
      // A request that named no actor keeps whoever was credited before.
      handledBy: sql`COALESCE(${reply.requested_by}, ${commentStates.handledBy})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commentStates.commentId, reply.in_reply_to_comment_id),
        // Answering does not overrule a decision someone already made.
        inArray(commentStates.handling, ["new", "escalated"]),
      ),
    );
}

async function loadReply(db: Database, replyId: string): Promise<ReplyRow | null> {
  const rows = await db
    .select({
      id: outboundReplies.id,
      tenant_id: outboundReplies.tenantId,
      channel_id: outboundReplies.channelId,
      in_reply_to_comment_id: outboundReplies.inReplyToCommentId,
      body: outboundReplies.body,
      status: outboundReplies.status,
      requested_by: outboundReplies.requestedBy,
      parent_external_id: comments.externalId,
      platform: sql<ReplyRow["platform"]>`${channels.platform}`,
      subject_external_id: channels.subjectExternalId,
      credential_id: channels.credentialId,
      credential_ref: platformCredentials.credentialRef,
    })
    .from(outboundReplies)
    .innerJoin(comments, eq(comments.id, outboundReplies.inReplyToCommentId))
    .innerJoin(channels, eq(channels.id, outboundReplies.channelId))
    .leftJoin(platformCredentials, eq(platformCredentials.id, channels.credentialId))
    .where(eq(outboundReplies.id, replyId));

  return rows.at(0) ?? null;
}

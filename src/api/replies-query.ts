import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { outboundReplies } from "../db/schema.js";
import { encodeId } from "./ids.js";

/** What the platform was asked to do and how far it got. */
export interface ReplyStatus {
  readonly id: string;
  readonly inReplyToCommentId: string;
  readonly status: string;
  readonly externalId: string | null;
  readonly postedAt: string | null;
  readonly error: { readonly code: string } | null;
  readonly createdAt: string;
}

export async function replyStatus(
  db: Database,
  tenantId: string,
  replyId: string,
): Promise<ReplyStatus | null> {
  const rows = await db
    .select({
      id: outboundReplies.id,
      status: outboundReplies.status,
      externalId: outboundReplies.externalId,
      postedAt: outboundReplies.postedAt,
      errorCode: outboundReplies.errorCode,
      inReplyToCommentId: outboundReplies.inReplyToCommentId,
      createdAt: outboundReplies.createdAt,
    })
    .from(outboundReplies)
    .where(and(eq(outboundReplies.id, replyId), eq(outboundReplies.tenantId, tenantId)));

  const row = rows.at(0);
  if (row === undefined) {
    return null;
  }
  return {
    id: encodeId("reply", row.id),
    inReplyToCommentId: encodeId("comment", row.inReplyToCommentId),
    status: row.status,
    externalId: row.externalId,
    postedAt: row.postedAt?.toISOString() ?? null,
    error: row.errorCode === null ? null : { code: row.errorCode },
    createdAt: row.createdAt.toISOString(),
  };
}

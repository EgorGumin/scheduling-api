import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { outboundReplies } from "../db/schema.js";
import { encodeId } from "./ids.js";
import type { ReplyStatus } from "./schemas.js";

export type { ReplyStatus };

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
    // The column is text with a check constraint; the schema names the same set.
    status: row.status as ReplyStatus["status"],
    externalId: row.externalId,
    postedAt: row.postedAt?.toISOString() ?? null,
    error: row.errorCode === null ? null : { code: row.errorCode },
    createdAt: row.createdAt.toISOString(),
  };
}

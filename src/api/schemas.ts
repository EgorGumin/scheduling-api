import { z } from "zod";
import { triageStateSchema } from "../domain/triage.js";
import {
  actionSchema,
  attachmentLimitsSchema,
  capabilityDeclarationSchema,
  publicOperationSchema,
  textLimitsSchema,
} from "../platform/capabilities.js";
import { LIFECYCLE, MEDIA_KINDS, PLATFORMS } from "../platform/types.js";
import { problemSchema } from "./errors.js";
import { idPattern, type IdKind } from "./ids.js";

export const wire = z.registry<{ id: string }>();

const publish = <T extends z.ZodType>(id: string, schema: T): T => {
  wire.add(schema, { id });
  return schema;
};

const identifier = (kind: IdKind, id: string) =>
  publish(id, z.string().regex(idPattern(kind)));

const channelId = identifier("channel", "ChannelId");
const postId = identifier("post", "PostId");
const commentId = identifier("comment", "CommentId");
const replyId = identifier("reply", "ReplyId");

const timestamp = publish("Timestamp", z.iso.datetime().meta({ description: "RFC 3339, UTC." }));

publish("TextLimits", textLimitsSchema);
publish("AttachmentLimits", attachmentLimitsSchema);
publish("Operation", publicOperationSchema);
publish("Capabilities", capabilityDeclarationSchema);
publish("Action", actionSchema);
publish("TriageState", triageStateSchema);
publish("Problem", problemSchema);

export const mediaRefSchema = publish(
  "MediaRef",
  z.object({
    type: z.enum(MEDIA_KINDS),
    url: z.string(),
    altText: z.string().optional(),
  }),
);

export const commentViewSchema = publish(
  "Comment",
  z.object({
    id: commentId,
    channelId,
    postId,
    platform: z.enum(PLATFORMS),
    parentId: commentId.nullable(),
    depth: z.int().nonnegative(),
    author: z
      .object({
        id: z.string(),
        displayName: z.string().nullable(),
        handle: z.string().nullable(),
      })
      .nullable(),
    body: z.string().nullable(),
    media: z.array(mediaRefSchema),
    direction: z.enum(["inbound", "outbound"]),
    lifecycle: z.enum(LIFECYCLE),
    createdAt: timestamp,
    editedAt: timestamp.nullable(),
    firstSeenAt: timestamp,
    state: triageStateSchema.nullable().meta({
      description: "Our triage record. Null on a reply we sent: triage does not apply to it.",
    }),
    actions: z.object({ reply: actionSchema }),
    replyIds: z.array(replyId),
  }),
);
export type CommentView = z.infer<typeof commentViewSchema>;

export const postRefSchema = publish(
  "Post",
  z.object({
    id: postId,
    preview: z.string().nullable(),
    permalink: z.string().nullable(),
    publishedAt: timestamp.nullable(),
    publisherPostId: z.string().nullable(),
  }),
);
export type PostRef = z.infer<typeof postRefSchema>;

export const commentPageSchema = publish(
  "CommentPage",
  z.object({
    data: z.array(commentViewSchema),
    included: z.object({ posts: z.array(postRefSchema) }),
    page: z.object({
      nextCursor: z.string().nullable().meta({
        description: "Opaque. Pass it back as `cursor`; null means this was the last page.",
      }),
    }),
  }),
);

/** Mirrors the check constraint on `outbound_replies.status`. */
export const REPLY_STATUSES = [
  "queued",
  "sending",
  "retrying",
  "posted",
  "failed",
  "expired",
] as const;

export const replyStatusSchema = publish(
  "Reply",
  z.object({
    id: replyId,
    inReplyToCommentId: commentId,
    status: z.enum(REPLY_STATUSES),
    externalId: z.string().nullable().meta({
      description: "The platform's own identifier for the reply, once it has one.",
    }),
    postedAt: timestamp.nullable(),
    error: z.object({ code: z.string() }).nullable(),
    createdAt: timestamp,
  }),
);
export type ReplyStatus = z.infer<typeof replyStatusSchema>;

export type Problem = z.infer<typeof problemSchema>;

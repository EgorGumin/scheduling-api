import type { PlatformManifest } from "../platform/capabilities.js";
import type { CommentProvider } from "../platform/port.js";
import {
  PlatformError,
  type ChannelContext,
  type Platform,
  type ListQuery,
  type Page,
  type PostedReply,
  type RawComment,
  type ReplyCommand,
} from "../platform/types.js";

export const fakeManifest: PlatformManifest = {
  platform: "instagram",
  operations: {
    reply: {
      supported: true,
      requiredScopes: ["instagram_manage_comments"],
      actionableForHours: null,
      text: { maxLength: 100 },
      attachments: { maxCount: 0, mimeTypes: [], maxBytes: 0 },
      maxDepth: 1,
    },
  },
};

export interface FakeScript {
  /** Comments to return, keyed by post external id. */
  readonly threads?: Record<string, readonly RawComment[]>;
}

/**
 * Stands in for a platform in tests, and is the second implementation the
 * conformance suite runs against.
 */
export class FakeProvider implements CommentProvider {
  readonly platform: Platform;
  readonly manifest: PlatformManifest;

  readonly posted: ReplyCommand[] = [];

  constructor(
    private script: FakeScript = {},
    platform: Platform = "instagram",
  ) {
    this.platform = platform;
    this.manifest = { ...fakeManifest, platform };
  }

  async listComments(_ctx: ChannelContext, query: ListQuery): Promise<Page<RawComment>> {
    const key = query.postExternalId;
    if (key === undefined) {
      throw new PlatformError("constraint_violated", "post identifier required", false);
    }

    const items = this.script.threads?.[key] ?? [];
    const since = query.since;
    return {
      items:
        since === undefined
          ? items
          : items.filter((c) => (c.remoteVersion ?? c.createdAtRemote) >= since),
      cursor: null,
    };
  }

  async postReply(ctx: ChannelContext, cmd: ReplyCommand): Promise<PostedReply> {
    if (ctx.credentialRef === null) {
      throw new PlatformError("unauthorized", "no credential", false);
    }
    this.posted.push(cmd);
    return { externalId: `ext-reply-${this.posted.length}`, postedAt: new Date() };
  }
}

let sequence = 0;

export function makeComment(overrides: Partial<RawComment> = {}): RawComment {
  sequence += 1;
  return {
    externalId: `ext-${sequence}`,
    postExternalId: "post-1",
    parentExternalId: null,
    author: { externalId: `author-${sequence}`, displayName: "Someone", handle: "someone" },
    body: `comment ${sequence}`,
    media: [],
    createdAtRemote: new Date("2026-08-20T10:00:00Z"),
    editedAtRemote: null,
    remoteVersion: new Date("2026-08-20T10:00:00Z"),
    lifecycle: "active",
    replyDisabled: false,
    ...overrides,
  };
}

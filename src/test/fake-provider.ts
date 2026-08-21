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
  type RawPost,
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
  /** What the platform says about the post itself, keyed by post external id. */
  readonly posts?: Record<string, RawPost>;
  /** Errors to raise instead of answering, keyed by post external id. */
  readonly failures?: Record<string, PlatformError>;
  /** When set, the thread is answered in pages of this size. */
  readonly pageSize?: number;
}

/**
 * Stands in for a platform in tests, and is the second implementation the
 * conformance suite runs against.
 */
export class FakeProvider implements CommentProvider {
  readonly platform: Platform;
  readonly manifest: PlatformManifest;

  listCalls = 0;
  readonly posted: ReplyCommand[] = [];

  constructor(
    private script: FakeScript = {},
    platform: Platform = "instagram",
  ) {
    this.platform = platform;
    this.manifest = { ...fakeManifest, platform };
  }

  setScript(script: FakeScript): void {
    this.script = script;
  }

  async listComments(_ctx: ChannelContext, query: ListQuery): Promise<Page<RawComment>> {
    this.listCalls += 1;
    const key = query.postExternalId;
    if (key === undefined) {
      throw new PlatformError("constraint_violated", "post identifier required", false);
    }
    const failure = this.script.failures?.[key];
    if (failure !== undefined) {
      throw failure;
    }

    const items = this.script.threads?.[key] ?? [];
    const since = query.since;
    const matching =
      since === undefined
        ? items
        : items.filter((c) => (c.remoteVersion ?? c.createdAtRemote) >= since);

    // Carried on the first page only, the way a platform that returns the post
    // alongside its thread does it.
    const post = query.cursor === undefined ? this.script.posts?.[key] : undefined;

    const size = this.script.pageSize;
    if (size === undefined) {
      return { items: matching, cursor: null, ...(post && { post }) };
    }
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    const next = offset + size;
    return {
      items: matching.slice(offset, next),
      cursor: next < matching.length ? String(next) : null,
      ...(post && { post }),
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

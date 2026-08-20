import { blueskyManifest } from "../manifests.js";
import type { CommentProvider } from "../port.js";
import {
  PlatformError,
  type ChannelContext,
  type Lifecycle,
  type ListQuery,
  type MediaRef,
  type Page,
  type PostedReply,
  type RawComment,
  type RawPost,
  type ReplyCommand,
} from "../types.js";
import { AppViewClient, type AppViewOptions } from "./appview.js";
import { parseAtUri } from "./at-uri.js";

/**
 * The most the AppView accepts; asking for 1001 is rejected by the lexicon. A
 * smaller number would drop deeper replies from the read silently, because the
 * response gives a truncated node and a complete one the same shape.
 */
const THREAD_DEPTH = 1000;

const THREAD_VIEW = "app.bsky.feed.defs#threadViewPost";

export class BlueskyProvider implements CommentProvider {
  readonly platform = "bluesky" as const;
  readonly manifest = blueskyManifest;

  private readonly appView: AppViewClient;

  constructor(options: AppViewOptions = {}) {
    this.appView = new AppViewClient(options);
  }

  /** The platform returns a whole thread in one call, so `cursor` is always null. */
  async listComments(_ctx: ChannelContext, query: ListQuery): Promise<Page<RawComment>> {
    const postExternalId = query.postExternalId;
    if (postExternalId === undefined) {
      throw new PlatformError(
        "constraint_violated",
        "bluesky lists comments per post; a post identifier is required",
        false,
      );
    }

    const thread = await this.fetchThread(postExternalId);
    if (thread === null) {
      return { items: [], cursor: null };
    }

    const items: RawComment[] = [];
    collectReplies(thread, postExternalId, items);

    const since = query.since;

    return {
      items:
        since === undefined
          ? items
          : items.filter((comment) => comment.createdAtRemote >= since),
      cursor: null,
      post: toRawPost(thread, postExternalId),
    };
  }

  async postReply(ctx: ChannelContext, _cmd: ReplyCommand): Promise<PostedReply> {
    if (ctx.credentialRef === null) {
      throw new PlatformError(
        "unauthorized",
        "channel is read-only: replying needs a connected account",
        false,
      );
    }
    throw new PlatformError(
      "unavailable",
      "bluesky write path is not enabled in this build",
      false,
    );
  }

  /**
   * `thread` comes back as one of a thread view, a not-found marker or a blocked
   * one. Null covers every case that is not a thread we can read.
   */
  private async fetchThread(uri: string): Promise<ThreadViewPost | null> {
    parseAtUri(uri);
    try {
      const response = await this.appView.query<{ thread: unknown }>(
        "app.bsky.feed.getPostThread",
        // parentHeight 0: ancestors above the requested post are of no interest.
        { uri, depth: THREAD_DEPTH, parentHeight: 0 },
      );
      return isThreadView(response.thread) ? response.thread : null;
    } catch (error) {
      if (error instanceof PlatformError && error.code === "not_found") {
        return null;
      }
      throw error;
    }
  }
}

/** A thread entry the platform let us read, or a marker for one it did not. */
type ThreadNode = ThreadViewPost | UnreadableNode;

interface ThreadViewPost {
  readonly $type?: string;
  readonly post: PostView;
  readonly replies?: readonly ThreadNode[];
}

interface UnreadableNode {
  /** `#notFoundPost` or `#blockedPost`. Nothing under it is worth walking. */
  readonly $type: string;
}

interface PostView {
  readonly uri: string;
  readonly author?: { did?: string; handle?: string; displayName?: string };
  readonly record?: {
    text?: string;
    createdAt?: string;
    reply?: { root?: { uri?: string }; parent?: { uri?: string } };
  };
  readonly embed?: unknown;
  readonly indexedAt?: string;
  readonly viewer?: { replyDisabled?: boolean };
}

/** By the platform's own tag: a marker that happened to carry a `post` would pass a shape check. */
function isThreadView(value: unknown): value is ThreadViewPost {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { $type?: unknown }).$type === THREAD_VIEW
  );
}

/**
 * The permalink is assembled rather than returned: this platform addresses
 * records by URI and leaves the web address to the client.
 */
function collectReplies(node: ThreadViewPost, postExternalId: string, out: RawComment[]): void {
  for (const reply of node.replies ?? []) {
    if (!isThreadView(reply)) {
      continue;
    }
    const comment = toRawComment(reply, postExternalId);
    if (comment !== null) {
      out.push(comment);
    }
    collectReplies(reply, postExternalId, out);
  }
}

function toRawPost(node: ThreadViewPost, externalPostId: string): RawPost {
  const post = node.post;
  const published = post.record?.createdAt ?? post.indexedAt;
  const publishedAt = published === undefined ? null : new Date(published);
  const handle = post.author?.handle;
  const rkey = externalPostId.split("/").at(-1);

  return {
    externalPostId,
    preview: post.record?.text ?? null,
    permalink:
      handle !== undefined && rkey !== undefined
        ? `https://bsky.app/profile/${handle}/post/${rkey}`
        : null,
    publishedAt: publishedAt !== null && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
  };
}

function toRawComment(node: ThreadViewPost, postExternalId: string): RawComment | null {
  const post = node.post;
  const createdAtRaw = post.record?.createdAt ?? post.indexedAt;
  if (typeof post.uri !== "string" || createdAtRaw === undefined) {
    return null;
  }
  const createdAtRemote = new Date(createdAtRaw);
  if (Number.isNaN(createdAtRemote.getTime())) {
    return null;
  }

  const authorDid = post.author?.did;
  const indexedAt = post.indexedAt === undefined ? null : new Date(post.indexedAt);

  return {
    externalId: post.uri,
    postExternalId,
    parentExternalId: post.record?.reply?.parent?.uri ?? null,
    author:
      authorDid === undefined
        ? null
        : {
            externalId: authorDid,
            displayName: post.author?.displayName ?? null,
            handle: post.author?.handle ?? null,
          },
    body: post.record?.text ?? null,
    media: extractMedia(post.embed),
    // Posts are immutable here, so there is no edit timestamp and `indexedAt`
    // is the only monotonic value available for conflict resolution.
    editedAtRemote: null,
    createdAtRemote,
    remoteVersion: indexedAt !== null && !Number.isNaN(indexedAt.getTime()) ? indexedAt : null,
    lifecycle: lifecycleOf(node),
    // `viewer` is the reading account's relationship to the post, and an
    // unauthenticated read has no such account. Absent means unobserved, which is
    // a different answer from "replies are allowed".
    replyDisabled: post.viewer === undefined ? null : post.viewer.replyDisabled === true,
  };
}

function lifecycleOf(node: ThreadViewPost): Lifecycle {
  return typeof node.post.uri === "string" ? "active" : "unknown";
}

/** URLs as the platform gives them; the bytes are never fetched or stored. */
function extractMedia(embed: unknown): readonly MediaRef[] {
  if (typeof embed !== "object" || embed === null) {
    return [];
  }
  const typed = embed as { $type?: unknown; images?: unknown; external?: unknown; media?: unknown };
  const type = typeof typed.$type === "string" ? typed.$type : "";

  if (type.startsWith("app.bsky.embed.recordWithMedia")) {
    return extractMedia(typed.media);
  }

  if (Array.isArray(typed.images)) {
    return typed.images.flatMap((image): MediaRef[] => {
      const entry = image as { fullsize?: unknown; thumb?: unknown; alt?: unknown };
      const url = typeof entry.fullsize === "string" ? entry.fullsize : entry.thumb;
      if (typeof url !== "string") {
        return [];
      }
      return [
        typeof entry.alt === "string" && entry.alt.length > 0
          ? { type: "image", url, altText: entry.alt }
          : { type: "image", url },
      ];
    });
  }

  if (typeof typed.external === "object" && typed.external !== null) {
    const external = typed.external as { uri?: unknown };
    if (typeof external.uri === "string") {
      return [{ type: "link_preview", url: external.uri }];
    }
  }

  if (type.startsWith("app.bsky.embed.video")) {
    const video = embed as { playlist?: unknown };
    if (typeof video.playlist === "string") {
      return [{ type: "video", url: video.playlist }];
    }
  }

  return [];
}

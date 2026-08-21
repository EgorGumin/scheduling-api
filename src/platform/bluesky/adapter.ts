import {
  AppBskyEmbedExternal,
  AppBskyEmbedGallery,
  AppBskyEmbedImages,
  AppBskyEmbedRecordWithMedia,
  AppBskyEmbedVideo,
  AppBskyFeedDefs,
  AppBskyFeedPost,
  ComAtprotoRepoStrongRef,
  type Agent,
} from "@atproto/api";
import { TID } from "@atproto/common-web";
import { validate as uuidValidate, version as uuidVersion } from "uuid";
import { isAtUriString } from "@atproto/syntax";
import { blueskyManifest } from "../manifests.js";
import type { CommentProvider } from "../port.js";
import {
  PlatformError,
  type ChannelContext,
  type ListQuery,
  type MediaRef,
  type Page,
  type PostedReply,
  type RawComment,
  type RawPost,
  type ReplyCommand,
} from "../types.js";
import { resolveSecret } from "../secrets.js";
import { openAppView, type AppViewOptions } from "./appview.js";
import { openSession, type SessionOptions } from "./pds.js";
import { toPlatformError } from "./transport.js";

/**
 * The most the AppView accepts, and the client rejects 1001 before sending it. A
 * smaller number would drop deeper replies from the read silently, because the
 * response gives a truncated node and a complete one the same shape.
 */
const THREAD_DEPTH = 1000;

const POST_COLLECTION = "app.bsky.feed.post";

export interface BlueskyOptions extends AppViewOptions {
  /** Writing options, separate because writes go to the account's own host. */
  readonly pds?: SessionOptions;
}

export class BlueskyProvider implements CommentProvider {
  readonly platform = "bluesky" as const;
  readonly manifest = blueskyManifest;

  private readonly appView: Agent;
  private readonly options: BlueskyOptions;
  /**
   * Sessions are reused. Logging in per reply would cost latency and run into a
   * published limit of thirty logins per five minutes on one account, which an
   * inbox answering a busy thread reaches on its own.
   */
  private readonly connections = new Map<string, Promise<Agent>>();

  constructor(options: BlueskyOptions = {}) {
    this.appView = openAppView(options);
    this.options = options;
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
          : items.filter((comment) => (comment.remoteVersion ?? comment.createdAtRemote) >= since),
      cursor: null,
      post: toRawPost(thread, postExternalId),
    };
  }

  /**
   * The record is named by the reply's own identifier, so a retry after a lost
   * answer rewrites that record rather than posting a second one. That is the
   * only place idempotency can live: the platform has no request key of its own.
   */
  async postReply(ctx: ChannelContext, cmd: ReplyCommand): Promise<PostedReply> {
    if (ctx.credentialRef === null || ctx.actingAs === null) {
      throw new PlatformError(
        "unauthorized",
        "channel is read-only: replying needs a connected account",
        false,
      );
    }

    const did = ctx.actingAs;
    const credentialRef = ctx.credentialRef;
    const key = JSON.stringify([did, credentialRef]);
    const reply = await this.replyRefs(cmd.parentExternalId);

    try {
      return await this.write(await this.connect(key, did, credentialRef), did, cmd, reply);
    } catch (error) {
      // The session refreshes itself; reaching here with an authorization failure
      // means the password no longer works, so the next reply logs in afresh.
      if (error instanceof PlatformError && error.code === "unauthorized") {
        this.connections.delete(key);
      }
      throw error;
    }
  }

  private connect(key: string, did: string, credentialRef: string): Promise<Agent> {
    const held = this.connections.get(key);
    if (held !== undefined) {
      return held;
    }

    // Cached before it resolves, so replies that arrive together share one login
    // instead of racing to make their own.
    const opening = openSession(did, resolveSecret(credentialRef), this.options.pds ?? {});
    this.connections.set(key, opening);
    void opening.catch(() => {
      if (this.connections.get(key) === opening) {
        this.connections.delete(key);
      }
    });
    return opening;
  }

  private async write(
    agent: Agent,
    did: string,
    cmd: ReplyCommand,
    reply: AppBskyFeedPost.ReplyRef,
  ): Promise<PostedReply> {
    const createdAt = new Date();
    const rkey = recordKey(cmd.replyId);
    try {
      const written = await agent.com.atproto.repo.putRecord({
        repo: did,
        collection: POST_COLLECTION,
        rkey,
        record: {
          $type: POST_COLLECTION,
          text: cmd.body,
          createdAt: createdAt.toISOString(),
          reply,
        },
      });
      return { externalId: written.data.uri, postedAt: createdAt };
    } catch (error) {
      throw toPlatformError(error, "reply");
    }
  }

  /**
   * A reply carries both the comment it answers and the top of the thread, each
   * as a URI with the content hash the platform assigned it. We store only URIs,
   * so the hashes are read back from the parent, which also reveals the root.
   */
  private async replyRefs(parentExternalId: string): Promise<AppBskyFeedPost.ReplyRef> {
    const node = await this.fetchThread(parentExternalId);
    if (node === null) {
      throw new PlatformError(
        "not_found",
        `cannot reply to ${parentExternalId}: the platform did not return it`,
        false,
      );
    }

    const parent: ComAtprotoRepoStrongRef.Main = { uri: node.post.uri, cid: node.post.cid };
    // A parent that is itself a reply names the thread's top; otherwise it is one.
    const root = postRecord(node.post)?.reply?.root;

    return { parent, root: root ?? parent };
  }

  /**
   * Null for everything that is not a thread we can read: the platform answers
   * with a marker instead of a post when one is missing, blocked or withheld.
   */
  private async fetchThread(uri: string): Promise<AppBskyFeedDefs.ThreadViewPost | null> {
    if (!isAtUriString(uri)) {
      throw new PlatformError("constraint_violated", `not an AT-URI: ${uri}`, false);
    }
    try {
      const response = await this.appView.app.bsky.feed.getPostThread({
        uri,
        depth: THREAD_DEPTH,
        // parentHeight 0: ancestors above the requested post are of no interest.
        parentHeight: 0,
      });
      const thread = response.data.thread;
      return AppBskyFeedDefs.isThreadViewPost(thread) ? thread : null;
    } catch (error) {
      const failure = toPlatformError(error, "thread");
      if (failure.code === "not_found") {
        return null;
      }
      throw failure;
    }
  }
}

/** A view carries the record untyped, because a repository holds whatever was put there. */
function postRecord(post: AppBskyFeedDefs.PostView): AppBskyFeedPost.Record | null {
  const checked = AppBskyFeedPost.validateRecord(post.record);
  return checked.success ? checked.value : null;
}

function collectReplies(
  node: AppBskyFeedDefs.ThreadViewPost,
  postExternalId: string,
  out: RawComment[],
): void {
  for (const reply of node.replies ?? []) {
    if (!AppBskyFeedDefs.isThreadViewPost(reply)) {
      continue;
    }
    const comment = toRawComment(reply, postExternalId);
    if (comment !== null) {
      out.push(comment);
    }
    collectReplies(reply, postExternalId, out);
  }
}

/**
 * The permalink is assembled here: the platform addresses records by URI and
 * leaves the web address to the client.
 */
function toRawPost(node: AppBskyFeedDefs.ThreadViewPost, externalPostId: string): RawPost {
  const post = node.post;
  const record = postRecord(post);
  const publishedAt = new Date(record?.createdAt ?? post.indexedAt);
  const handle = post.author.handle;
  const rkey = externalPostId.split("/").at(-1);

  return {
    externalPostId,
    preview: record?.text ?? null,
    permalink:
      rkey === undefined ? null : `https://bsky.app/profile/${handle}/post/${rkey}`,
    publishedAt: Number.isNaN(publishedAt.getTime()) ? null : publishedAt,
  };
}

function toRawComment(
  node: AppBskyFeedDefs.ThreadViewPost,
  postExternalId: string,
): RawComment | null {
  const post = node.post;
  const record = postRecord(post);
  const createdAtRemote = new Date(record?.createdAt ?? post.indexedAt);
  if (Number.isNaN(createdAtRemote.getTime())) {
    return null;
  }

  const indexedAt = new Date(post.indexedAt);

  return {
    externalId: post.uri,
    postExternalId,
    parentExternalId: record?.reply?.parent.uri ?? null,
    author: {
      externalId: post.author.did,
      displayName: post.author.displayName ?? null,
      handle: post.author.handle,
    },
    body: record?.text ?? null,
    media: extractMedia(post.embed),
    // Posts are immutable here, so there is no edit timestamp and `indexedAt`
    // is the only monotonic value available for conflict resolution.
    editedAtRemote: null,
    createdAtRemote,
    remoteVersion: Number.isNaN(indexedAt.getTime()) ? null : indexedAt,
    // The AppView returns a marker instead of a post for anything deleted or
    // blocked, and those are dropped before they get here.
    lifecycle: "active",
    // `viewer` is the reading account's relationship to the post, and an
    // unauthenticated read has no such account. Absent means unobserved, which is
    // a different answer from "replies are allowed".
    replyDisabled: post.viewer === undefined ? null : post.viewer.replyDisabled === true,
  };
}

/** URLs as the platform gives them; the bytes are never fetched or stored. */
function extractMedia(embed: AppBskyFeedDefs.PostView["embed"]): readonly MediaRef[] {
  // A quote post with an attachment: the quoted record is not media of ours.
  if (AppBskyEmbedRecordWithMedia.isView(embed)) {
    return extractMedia(embed.media);
  }
  if (AppBskyEmbedImages.isView(embed)) {
    return embed.images.map(toImage);
  }
  if (AppBskyEmbedGallery.isView(embed)) {
    return embed.items.filter(AppBskyEmbedGallery.isViewImage).map(toImage);
  }
  if (AppBskyEmbedVideo.isView(embed)) {
    return [{ type: "video", url: embed.playlist }];
  }
  if (AppBskyEmbedExternal.isView(embed)) {
    return [{ type: "link_preview", url: embed.external.uri }];
  }
  return [];
}

/** The lexicon makes alt text required, so an image without it carries an empty string. */
function toImage(image: { fullsize: string; alt: string }): MediaRef {
  const url = image.fullsize;
  return image.alt.length === 0
    ? { type: "image", url }
    : { type: "image", url, altText: image.alt };
}

/**
 * A post's key must be a TID: 53 bits of microseconds and a 10-bit clock. The
 * reply's uuid supplies both, so a retry names the same record. Version 7 only:
 * its leading bits are a millisecond timestamp, which sorts the key where the
 * reply belongs and keeps it inside the range a TID can hold.
 */
function recordKey(replyId: string): string {
  if (!uuidValidate(replyId) || uuidVersion(replyId) !== 7) {
    throw new PlatformError(
      "constraint_violated",
      `reply id ${replyId} is not a version 7 UUID, so it carries no time to sort by`,
      false,
    );
  }

  // 48 bits of milliseconds and 12 of sub-millisecond order, which stay inside a
  // safe integer even once multiplied out to microseconds.
  const hex = replyId.replaceAll("-", "");
  const milliseconds = Number.parseInt(hex.slice(0, 12), 16);
  const withinMillisecond = Number.parseInt(hex.slice(13, 16), 16) % 1000;
  const clock = Number.parseInt(hex.slice(17, 20), 16) & 0x3ff;
  return TID.fromTime(milliseconds * 1000 + withinMillisecond, clock).toString();
}

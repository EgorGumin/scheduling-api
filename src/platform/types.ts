export type Platform = "bluesky" | "instagram" | "facebook" | "youtube";

export type Lifecycle = "active" | "hidden" | "deleted" | "unknown";

export type MediaKind = "image" | "video" | "gif" | "link_preview" | "unknown";

export interface MediaRef {
  readonly type: MediaKind;
  readonly url: string;
  readonly altText?: string;
}

export interface RawAuthor {
  readonly externalId: string;
  readonly displayName: string | null;
  readonly handle: string | null;
}

export interface RawComment {
  readonly externalId: string;
  readonly postExternalId: string;
  /** Kept separate from the internal link: a child can arrive before its parent. */
  readonly parentExternalId: string | null;
  readonly author: RawAuthor | null;
  readonly body: string | null;
  readonly media: readonly MediaRef[];
  readonly createdAtRemote: Date;
  readonly editedAtRemote: Date | null;
  readonly remoteVersion: Date | null;
  readonly lifecycle: Lifecycle;
  /** `null` when the read carried no viewer state to report it. */
  readonly replyDisabled: boolean | null;
}

/** What the platform says about the post the comments hang off. */
export interface RawPost {
  readonly externalPostId: string;
  readonly preview: string | null;
  readonly permalink: string | null;
  readonly publishedAt: Date | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly cursor: string | null;
  /** Present when the platform returns the post in the same call. */
  readonly post?: RawPost;
}

export interface ChannelContext {
  readonly channelId: string;
  readonly tenantId: string;
  readonly platform: Platform;
  readonly subjectExternalId: string;
  readonly credentialRef: string | null;
}

export interface ListQuery {
  readonly postExternalId?: string;
  /**
   * Objects the platform indexed at or after this instant, compared against
   * `remoteVersion`. Creation time is written by whoever posted the comment and
   * can sit anywhere; index time is the platform's own and is what a reader can
   * resume from.
   */
  readonly since?: Date;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ReplyCommand {
  readonly parentExternalId: string;
  readonly body: string;
}

export interface PostedReply {
  readonly externalId: string;
  readonly postedAt: Date;
}

export type PlatformErrorCode =
  | "not_found"
  | "unauthorized"
  | "permission_denied"
  | "forbidden_by_author"
  | "window_expired"
  | "constraint_violated"
  | "rate_limited"
  | "unavailable"
  | "unknown";

export class PlatformError extends Error {
  constructor(
    readonly code: PlatformErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

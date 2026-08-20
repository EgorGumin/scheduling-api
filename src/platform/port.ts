import type { PlatformManifest } from "./capabilities.js";
import type {
  ChannelContext,
  ListQuery,
  Page,
  Platform,
  PostedReply,
  RawComment,
  ReplyCommand,
} from "./types.js";

export interface CommentProvider {
  readonly platform: Platform;
  readonly manifest: PlatformManifest;

  listComments(ctx: ChannelContext, query: ListQuery): Promise<Page<RawComment>>;
  postReply(ctx: ChannelContext, cmd: ReplyCommand): Promise<PostedReply>;
}

export class ProviderRegistry {
  private readonly byPlatform = new Map<Platform, CommentProvider>();

  constructor(providers: readonly CommentProvider[]) {
    for (const provider of providers) {
      this.byPlatform.set(provider.platform, provider);
    }
  }

  get(platform: Platform): CommentProvider {
    const provider = this.byPlatform.get(platform);
    if (provider === undefined) {
      throw new Error(`no provider registered for platform ${platform}`);
    }
    return provider;
  }

  has(platform: Platform): boolean {
    return this.byPlatform.has(platform);
  }
}

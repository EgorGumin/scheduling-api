import { describe, expect, it } from "vitest";
import type { ChannelContext } from "../types.js";
import { BlueskyProvider } from "./adapter.js";
import { openAppView } from "./appview.js";
import { isAtUriString } from "@atproto/syntax";

/**
 * Hits the real AppView with no credentials: `npm run test:live`.
 *
 * The thread is discovered rather than hardcoded so the test survives a post
 * being deleted. Listing a channel's posts belongs to publishing, so discovery
 * asks the AppView directly instead of going through the port.
 */
const ACCOUNT = "bsky.app";

const ctx: ChannelContext = {
  channelId: "chn-live",
  tenantId: "tnt-live",
  platform: "bluesky",
  subjectExternalId: ACCOUNT,
  actingAs: null,
  credentialRef: null,
};

describe("bluesky, live", () => {
  it("reads a real thread with no credentials", async () => {
    const feed = await openAppView().app.bsky.feed.getAuthorFeed({
      actor: ACCOUNT,
      limit: 30,
    });

    const busiest = [...feed.data.feed]
      .sort((a, b) => (b.post.replyCount ?? 0) - (a.post.replyCount ?? 0))
      .at(0);

    expect(busiest, `${ACCOUNT} returned an empty feed`).toBeDefined();
    const postUri = busiest!.post.uri;
    expect(isAtUriString(postUri)).toBe(true);

    const provider = new BlueskyProvider();
    const page = await provider.listComments(ctx, { postExternalId: postUri });

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.cursor).toBeNull();

    for (const comment of page.items) {
      expect(isAtUriString(comment.externalId)).toBe(true);
      expect(comment.postExternalId).toBe(postUri);
      expect(Number.isNaN(comment.createdAtRemote.getTime())).toBe(false);
      expect(comment.author?.externalId.startsWith("did:")).toBe(true);
    }
  });
});

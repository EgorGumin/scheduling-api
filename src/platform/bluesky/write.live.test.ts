/**
 * Posts a real reply and deletes it again: `npm run test:live`, skipped without an
 * account, where reads still run.
 *
 * The thread is a post that stays put, named by `BLUESKY_FIXTURE_POST`, with a
 * comment on it from another account. Creating a root post on every run would be
 * slower, would litter the account's feed, and still would not supply the one
 * thing this test needs: a comment somebody else wrote.
 */
import { describe, expect, it } from "vitest";
import type { ChannelContext } from "../types.js";
import { BlueskyProvider } from "./adapter.js";
import { openAppView } from "./appview.js";
import { openSession } from "./pds.js";
import { isAtUriString } from "@atproto/syntax";
import { v7 as uuidV7 } from "uuid";

const handle = process.env["BLUESKY_HANDLE"];
const password = process.env["BLUESKY_APP_PASSWORD"];
const fixturePost = process.env["BLUESKY_FIXTURE_POST"];
const configured = handle !== undefined && password !== undefined && fixturePost !== undefined;

const POST_COLLECTION = "app.bsky.feed.post";

describe.skipIf(!configured)("bluesky writes, live", () => {
  it("replies to somebody else's comment and takes the reply back", async () => {
    const resolved = await openAppView().com.atproto.identity.resolveHandle({
      handle: handle!,
    });
    const did = resolved.data.did;

    const ctx: ChannelContext = {
      channelId: "chn-live",
      tenantId: "tnt-live",
      platform: "bluesky",
      subjectExternalId: did,
      actingAs: did,
      credentialRef: "secret://env/BLUESKY_APP_PASSWORD",
    };

    const provider = new BlueskyProvider();
    const thread = await provider.listComments(ctx, { postExternalId: fixturePost! });

    const target = thread.items.find((comment) => comment.author?.externalId !== did);
    expect(
      target,
      `${fixturePost} has no comment from another account to answer`,
    ).toBeDefined();

    const replyId = uuidV7();
    const command = {
      parentExternalId: target!.externalId,
      body: `automated check ${replyId.slice(0, 8)}`,
      replyId,
    };

    const posted = await provider.postReply(ctx, command);
    expect(isAtUriString(posted.externalId)).toBe(true);

    const retried = await provider.postReply(ctx, command);
    expect(retried.externalId).toBe(posted.externalId);

    const agent = await openSession(did, password!);
    const rkey = posted.externalId.split("/").at(-1)!;
    try {
      const stored = await agent.com.atproto.repo.getRecord({
        repo: did,
        collection: POST_COLLECTION,
        rkey,
      });
      expect((stored.data.value as { text: string }).text).toContain(replyId.slice(0, 8));

      const thread = await provider.listComments(ctx, { postExternalId: fixturePost! });
      const ours = thread.items.filter((comment) => comment.body === command.body);
      // At most one, never two: the AppView indexes a new record with a delay, so
      // zero means it has not caught up yet, while two would mean the retry posted
      // a second reply.
      expect(ours.length).toBeLessThanOrEqual(1);
    } finally {
      await agent.com.atproto.repo.deleteRecord({
        repo: did,
        collection: POST_COLLECTION,
        rkey,
      });
    }
  });
});

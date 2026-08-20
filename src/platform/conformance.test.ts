import { describe } from "vitest";
import { runConformance } from "./conformance.js";
import { BlueskyProvider } from "./bluesky/adapter.js";
import { FakeProvider, makeComment } from "../test/fake-provider.js";
import type { ChannelContext } from "./types.js";
import fixture from "./bluesky/__fixtures__/thread-with-replies.json" with { type: "json" };

const BLUESKY_POST = "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3msqpuobiwk2t";

function ctxFor(platform: ChannelContext["platform"]): ChannelContext {
  return {
    channelId: "chn-conformance",
    tenantId: "tnt-conformance",
    platform,
    subjectExternalId: "subject",
    credentialRef: null,
  };
}

describe("port conformance", () => {
  runConformance("bluesky", async () => ({
    provider: new BlueskyProvider({
      // Answers only for the captured thread, so the suite can tell a known
      // identifier from an unknown one the way the real service does.
      fetchImpl: async (input) => {
        const uri = new URL(String(input)).searchParams.get("uri");
        return uri === BLUESKY_POST
          ? new Response(JSON.stringify(fixture), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ error: "NotFound" }), { status: 400 });
      },
    }),
    ctx: ctxFor("bluesky"),
    postExternalId: BLUESKY_POST,
    unknownExternalId: "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/nothinghere",
  }));

  runConformance("fake", async () => ({
    provider: new FakeProvider({
      threads: {
        "post-1": [
          makeComment({ postExternalId: "post-1" }),
          makeComment({
            postExternalId: "post-1",
            media: [{ type: "image", url: "https://cdn.example/x.jpg" }],
          }),
        ],
      },
    }),
    ctx: ctxFor("instagram"),
    postExternalId: "post-1",
    unknownExternalId: "definitely-not-a-real-id",
  }));
});

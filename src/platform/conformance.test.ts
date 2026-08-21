import { describe } from "vitest";
import { runConformance } from "./conformance.js";
import { BlueskyProvider } from "./bluesky/adapter.js";
import { FakeProvider, makeComment } from "../test/fake-provider.js";
import type { ChannelContext } from "./types.js";
import fixture from "./bluesky/__fixtures__/thread-with-replies.json" with { type: "json" };

const BLUESKY_POST = "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3msqpuobiwk2t";
const BLUESKY_ACTOR = "did:plc:z72i7hdynmk6r22z27h6tvur";

/** Stands in for the secret store, the way a deployment's environment does. */
const PASSWORD_REF = "secret://env/CONFORMANCE_PASSWORD";
process.env["CONFORMANCE_PASSWORD"] = "app-pass";

function ctxFor(platform: ChannelContext["platform"]): ChannelContext {
  return {
    channelId: "chn-conformance",
    tenantId: "tnt-conformance",
    platform,
    subjectExternalId: "subject",
    actingAs: null,
    credentialRef: null,
  };
}

function connectedTo(platform: ChannelContext["platform"], actor: string): ChannelContext {
  return { ...ctxFor(platform), actingAs: actor, credentialRef: PASSWORD_REF };
}

/**
 * Answers only for the captured thread, so the suite can tell a known identifier
 * from an unknown one the way the real service does. Writes are answered too,
 * with the record named where the adapter asked for it — which is what lets the
 * suite check that one reply sent twice stays one record.
 */
function blueskyStub(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request === null ? String(input) : request.url);
    const method = url.pathname.replace("/xrpc/", "");
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (method === "com.atproto.server.createSession") {
      return json({
        did: BLUESKY_ACTOR,
        handle: "conformance.example",
        accessJwt: "access",
        refreshJwt: "refresh",
        active: true,
      });
    }
    if (method === "com.atproto.repo.putRecord") {
      const body = request === null ? String(init?.body) : await request.text();
      const { rkey } = JSON.parse(body) as { rkey: string };
      return json({
        uri: `at://${BLUESKY_ACTOR}/app.bsky.feed.post/${rkey}`,
        cid: "bafyreia5giteuhei7im66w7yn3pldm7h7npkmuy73fvakrpsjsz5oejdgu",
      });
    }
    return url.searchParams.get("uri") === BLUESKY_POST
      ? json(fixture)
      : json({ error: "NotFound" }, 400);
  }) as unknown as typeof fetch;
}

describe("port conformance", () => {
  runConformance("bluesky", async () => {
    const fetchImpl = blueskyStub();
    return {
      provider: new BlueskyProvider({
        fetchImpl,
        pds: { serviceUrl: "https://pds.example", fetchImpl },
      }),
      ctx: ctxFor("bluesky"),
      connected: connectedTo("bluesky", BLUESKY_ACTOR),
      postExternalId: BLUESKY_POST,
      unknownExternalId: "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/nothinghere",
    };
  });

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
    connected: connectedTo("instagram", "author-1"),
    postExternalId: "post-1",
    unknownExternalId: "definitely-not-a-real-id",
  }));
});

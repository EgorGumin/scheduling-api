import { describe, expect, it } from "vitest";
import type { ChannelContext } from "../types.js";
import { PlatformError } from "../types.js";
import { BlueskyProvider } from "./adapter.js";
import fixture from "./__fixtures__/thread-with-replies.json" with { type: "json" };

/** Verbatim AppView output, captured by `scripts/capture-fixture.ts`. */
const ROOT_URI = "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3msqpuobiwk2t";

const ctx: ChannelContext = {
  channelId: "chn-1",
  tenantId: "tnt-1",
  platform: "bluesky",
  subjectExternalId: "did:plc:z72i7hdynmk6r22z27h6tvur",
  credentialRef: null,
};

function providerReturning(body: unknown, status = 200): BlueskyProvider {
  return new BlueskyProvider({
    fetchImpl: async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  });
}

describe("bluesky adapter", () => {
  it("flattens a nested thread into comments carrying their parent reference", async () => {
    const page = await providerReturning(fixture).listComments(ctx, {
      postExternalId: ROOT_URI,
    });

    expect(page.items.length).toBeGreaterThan(0);
    for (const comment of page.items) {
      expect(comment.postExternalId).toBe(ROOT_URI);
      expect(comment.externalId.startsWith("at://")).toBe(true);
      expect(comment.createdAtRemote.getTime()).not.toBeNaN();
    }

    const nested = page.items.filter((c) => c.parentExternalId !== ROOT_URI);
    expect(nested.length).toBeGreaterThan(0);
  });

  it("reports no cursor, because the platform returns the whole thread", async () => {
    const page = await providerReturning(fixture).listComments(ctx, {
      postExternalId: ROOT_URI,
    });
    expect(page.cursor).toBeNull();
  });

  it("filters by `since` itself, because the platform has no such parameter", async () => {
    const provider = providerReturning(fixture);
    const all = await provider.listComments(ctx, { postExternalId: ROOT_URI });
    const cutoff = new Date(Date.now() + 86_400_000);
    const none = await provider.listComments(ctx, {
      postExternalId: ROOT_URI,
      since: cutoff,
    });

    expect(all.items.length).toBeGreaterThan(0);
    expect(none.items).toHaveLength(0);
  });

  it("filters on the platform's index time, not on the timestamp its author wrote", async () => {
    // This reply was written by a client whose clock ran ahead: the platform
    // indexed it at 20:06:38.374, its own record claims 20:06:39.191.
    const clockAhead = "at://did:plc:zyjbzxt6eqzmbfqrgyvuaqfx/app.bsky.feed.post/3msqvma6ays2j";
    const cutoff = new Date("2026-08-10T20:06:39.000Z");
    const provider = providerReturning(fixture);

    const all = await provider.listComments(ctx, { postExternalId: ROOT_URI });
    const written = all.items.find((comment) => comment.externalId === clockAhead);
    expect(written?.createdAtRemote.getTime()).toBeGreaterThan(cutoff.getTime());

    const page = await provider.listComments(ctx, { postExternalId: ROOT_URI, since: cutoff });

    expect(page.items.map((comment) => comment.externalId)).not.toContain(clockAhead);
    expect(page.items.length).toBeGreaterThan(0);
  });

  it("keeps media as references the platform can serve", async () => {
    const page = await providerReturning(fixture).listComments(ctx, {
      postExternalId: ROOT_URI,
    });
    for (const comment of page.items) {
      for (const media of comment.media) {
        expect(media.url.startsWith("http")).toBe(true);
        expect(media.type).not.toBe("unknown");
      }
    }
  });

  it("refuses to list channel-wide, which this platform cannot do", async () => {
    await expect(providerReturning(fixture).listComments(ctx, {})).rejects.toThrow(
      PlatformError,
    );
  });

  it("rejects an identifier that is not an AT-URI before making a call", async () => {
    let called = false;
    const provider = new BlueskyProvider({
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });

    await expect(
      provider.listComments(ctx, { postExternalId: "12345" }),
    ).rejects.toMatchObject({ code: "constraint_violated" });
    expect(called).toBe(false);
  });

  it("treats a missing thread as an empty page rather than a failure", async () => {
    const provider = providerReturning({ error: "NotFound" }, 400);
    const page = await provider.listComments(ctx, { postExternalId: ROOT_URI });
    expect(page.items).toHaveLength(0);
  });

  it("marks a rate limit retryable", async () => {
    const limited = providerReturning({}, 429);
    await expect(
      limited.listComments(ctx, { postExternalId: ROOT_URI }),
    ).rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("marks a bad request permanent", async () => {
    const rejected = providerReturning({ error: "InvalidRequest" }, 400);
    await expect(
      rejected.listComments(ctx, { postExternalId: ROOT_URI }),
    ).rejects.toMatchObject({ code: "constraint_violated", retryable: false });
  });

  it("refuses to reply through a read-only channel", async () => {
    await expect(
      providerReturning(fixture).postReply(ctx, {
        parentExternalId: ROOT_URI,
        body: "hello",
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});

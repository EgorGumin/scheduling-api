import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelContext } from "../types.js";
import { PlatformError } from "../types.js";
import { BlueskyProvider } from "./adapter.js";
/** Verbatim AppView output, captured by `scripts/capture-fixture.ts`. */
import fixture from "./__fixtures__/thread-with-replies.json" with { type: "json" };

const ROOT_URI = "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3msqpuobiwk2t";
const ROOT_CID = "bafyreia5giteuhei7im66w7yn3pldm7h7npkmuy73fvakrpsjsz5oejdgu";

const ctx: ChannelContext = {
  channelId: "chn-1",
  tenantId: "tnt-1",
  platform: "bluesky",
  subjectExternalId: "did:plc:z72i7hdynmk6r22z27h6tvur",
  actingAs: null,
  credentialRef: null,
};

interface Call {
  method: string;
  host: string;
  body?: unknown;
}

/** The host the login's DID document names, which is not the one it logged in at. */
const PDS_HOST = "pds.example";
const ENTRYWAY = "https://entryway.example";

/** A record uri the lexicon accepts: the SDK validates what comes back. */
const WRITTEN = "at://did:plc:us/app.bsky.feed.post/3mtjkir222222";
const REFRESHED = "at://did:plc:us/app.bsky.feed.post/3mtjkir222223";

const DID = "did:plc:us";

/** A login answer, carrying the document that moves the client to the repository host. */
const SESSION = {
  did: DID,
  handle: "us.example",
  accessJwt: "access-1",
  refreshJwt: "refresh-1",
  active: true,
  didDoc: {
    id: DID,
    service: [
      {
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: `https://${PDS_HOST}`,
      },
    ],
  },
};

/**
 * Routes each XRPC method to a canned answer and keeps every call. An answer may
 * be a function, which is how a test makes the platform behave differently the
 * second time.
 */
function writingProvider(answers: Record<string, unknown>, calls: Call[] = []): BlueskyProvider {
  const counts = new Map<string, number>();
  // Reads arrive as a URL, writes as a Request: the session builds one before it
  // signs the call.
  const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(input instanceof Request ? input.url : input);
    const method = url.pathname.replace("/xrpc/", "");
    const sent = request === null ? init?.body : await request.text();
    const seen = (counts.get(method) ?? 0) + 1;
    counts.set(method, seen);
    calls.push({
      method,
      host: url.hostname,
      ...(typeof sent === "string" && sent.length > 0 && { body: JSON.parse(sent) }),
    });

    const answer = answers[method];
    if (answer === undefined) {
      return new Response(JSON.stringify({ error: "InvalidRequest" }), { status: 400 });
    }
    return typeof answer === "function"
      ? (answer as (call: number) => Response)(seen)
      : json(answer);
  };

  return new BlueskyProvider({ fetchImpl, pds: { serviceUrl: ENTRYWAY, fetchImpl } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CONNECTED: ChannelContext = {
  ...ctx,
  actingAs: DID,
  credentialRef: "secret://env/TEST_APP_PASSWORD",
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

/** A uri of its own, so the reply carrying the embed is easy to pick out of the page. */
const EMBED_URI = "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3msqembed222";

const THUMB = "https://cdn.example/s.jpg";
const FULL = "https://cdn.example/l.jpg";

/** The captured thread with one more reply, cloned from a real one and given an embed. */
function threadWithEmbed(embed: unknown): unknown {
  const template = fixture.thread.replies[0]!;
  const carrying = {
    ...template,
    post: { ...template.post, uri: EMBED_URI, embed },
    replies: [],
  };
  return { thread: { ...fixture.thread, replies: [...fixture.thread.replies, carrying] } };
}

describe("bluesky adapter", () => {
  beforeEach(() => {
    process.env["TEST_APP_PASSWORD"] = "app-pass";
  });

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

  /**
   * The captured thread carries an image on the root post, which the port reports
   * as a post rather than a comment, so nothing here exercised the mapping. Each
   * case hangs a real reply node off the thread with one embed swapped in.
   */
  it.each([
    [
      "an image, with its alt text",
      {
        $type: "app.bsky.embed.images#view",
        images: [{ thumb: THUMB, fullsize: FULL, alt: "a guitar" }],
      },
      [{ type: "image", url: FULL, altText: "a guitar" }],
    ],
    [
      "an image whose alt text the author left empty",
      {
        $type: "app.bsky.embed.images#view",
        images: [{ thumb: THUMB, fullsize: FULL, alt: "" }],
      },
      [{ type: "image", url: FULL }],
    ],
    [
      "a video, by the playlist that plays it",
      { $type: "app.bsky.embed.video#view", cid: ROOT_CID, playlist: "https://cdn.example/v.m3u8" },
      [{ type: "video", url: "https://cdn.example/v.m3u8" }],
    ],
    [
      "a link card, by the address it points at",
      {
        $type: "app.bsky.embed.external#view",
        external: { uri: "https://example.com/post", title: "Title", description: "Description" },
      },
      [{ type: "link_preview", url: "https://example.com/post" }],
    ],
    [
      "the attachment of a quote post, not the quoted record",
      {
        $type: "app.bsky.embed.recordWithMedia#view",
        record: {
          $type: "app.bsky.embed.record#view",
          record: { $type: "app.bsky.embed.record#viewNotFound", uri: ROOT_URI, notFound: true },
        },
        media: {
          $type: "app.bsky.embed.images#view",
          images: [{ thumb: THUMB, fullsize: FULL, alt: "" }],
        },
      },
      [{ type: "image", url: FULL }],
    ],
  ])("maps %s", async (_case, embed, expected) => {
    const page = await providerReturning(threadWithEmbed(embed)).listComments(ctx, {
      postExternalId: ROOT_URI,
    });

    const commented = page.items.find((comment) => comment.externalId === EMBED_URI);
    expect(commented?.media).toEqual(expected);
  });

  it("reports no media for a quote post, which carries a record and no attachment", async () => {
    const page = await providerReturning(
      threadWithEmbed({
        $type: "app.bsky.embed.record#view",
        record: { $type: "app.bsky.embed.record#viewNotFound", uri: ROOT_URI, notFound: true },
      }),
    ).listComments(ctx, { postExternalId: ROOT_URI });

    expect(page.items.find((comment) => comment.externalId === EMBED_URI)?.media).toEqual([]);
  });

  it("refuses to list channel-wide, which this platform cannot do", async () => {
    await expect(providerReturning(fixture).listComments(ctx, {})).rejects.toThrow(PlatformError);
  });

  it("rejects an identifier that is not an AT-URI before making a call", async () => {
    let called = false;
    const provider = new BlueskyProvider({
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });

    await expect(provider.listComments(ctx, { postExternalId: "12345" })).rejects.toMatchObject({
      code: "constraint_violated",
    });
    expect(called).toBe(false);
  });

  it("treats a missing thread as an empty page rather than a failure", async () => {
    const provider = providerReturning({ error: "NotFound" }, 400);
    const page = await provider.listComments(ctx, { postExternalId: ROOT_URI });
    expect(page.items).toHaveLength(0);
  });

  it("marks a rate limit retryable", async () => {
    const limited = providerReturning({}, 429);
    await expect(limited.listComments(ctx, { postExternalId: ROOT_URI })).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
  });

  it("marks a bad request permanent", async () => {
    const rejected = providerReturning({ error: "InvalidRequest" }, 400);
    await expect(rejected.listComments(ctx, { postExternalId: ROOT_URI })).rejects.toMatchObject({
      code: "constraint_violated",
      retryable: false,
    });
  });

  it("refuses to reply through a read-only channel", async () => {
    await expect(
      providerReturning(fixture).postReply(ctx, {
        parentExternalId: ROOT_URI,
        body: "hello",
        replyId: "01a01fc6-0000-7000-8000-000000000001",
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("names the record from the reply id, which is what lets a retry rewrite it", async () => {
    const sent: Call[] = [];
    const provider = writingProvider(
      {
        "com.atproto.server.createSession": SESSION,
        "app.bsky.feed.getPostThread": fixture,
        "com.atproto.repo.putRecord": { uri: `${ROOT_URI}x`, cid: ROOT_CID },
      },
      sent,
    );

    const posted = await provider.postReply(CONNECTED, {
      parentExternalId: ROOT_URI,
      body: "on it",
      replyId: "01a01fc6-0000-7000-8000-000000000001",
    });

    expect(posted.externalId).toBe(`${ROOT_URI}x`);
    expect(sent).toContainEqual({
      method: "com.atproto.repo.putRecord",
      host: PDS_HOST,
      body: {
        repo: DID,
        collection: "app.bsky.feed.post",
        rkey: "3mtjkir222222",
        record: {
          $type: "app.bsky.feed.post",
          text: "on it",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- the matcher is typed as `any`
          createdAt: expect.any(String),
          reply: {
            parent: { uri: ROOT_URI, cid: ROOT_CID },
            root: { uri: ROOT_URI, cid: ROOT_CID },
          },
        },
      },
    });
  });

  it("keeps the thread's root when answering a reply rather than the post", async () => {
    const sent: Call[] = [];
    const nested = fixture.thread.replies[0]!;
    const provider = writingProvider(
      {
        "com.atproto.server.createSession": SESSION,
        "app.bsky.feed.getPostThread": { thread: nested },
        "com.atproto.repo.putRecord": { uri: WRITTEN, cid: ROOT_CID },
      },
      sent,
    );

    await provider.postReply(CONNECTED, {
      parentExternalId: nested.post.uri,
      body: "deeper",
      replyId: "01a01fc6-0000-7000-8000-000000000002",
    });

    const record = (sent.at(-1) as { body: { record: { reply: unknown } } }).body.record;
    expect(record.reply).toEqual({
      parent: { uri: nested.post.uri, cid: nested.post.cid },
      root: { uri: ROOT_URI, cid: ROOT_CID },
    });
  });

  it("writes to the host the account's DID document names", async () => {
    const calls: Call[] = [];
    const provider = writingProvider(
      {
        "com.atproto.server.createSession": SESSION,
        "app.bsky.feed.getPostThread": fixture,
        "com.atproto.repo.putRecord": { uri: WRITTEN, cid: ROOT_CID },
      },
      calls,
    );

    await provider.postReply(CONNECTED, {
      parentExternalId: ROOT_URI,
      body: "on it",
      replyId: "01a01fc6-0000-7000-8000-000000000010",
    });

    // The login happens at the entryway, which answers with the account's
    // document; every call after that has to reach the host that document names.
    const login = calls.find((call) => call.method === "com.atproto.server.createSession");
    expect(login?.host).toBe(new URL(ENTRYWAY).hostname);
    expect(calls.find((call) => call.method === "com.atproto.repo.putRecord")?.host).toBe(PDS_HOST);
  });

  it("logs in once for several replies", async () => {
    const calls: Call[] = [];
    const provider = writingProvider(
      {
        "com.atproto.server.createSession": SESSION,
        "app.bsky.feed.getPostThread": fixture,
        "com.atproto.repo.putRecord": { uri: WRITTEN, cid: ROOT_CID },
      },
      calls,
    );

    for (const suffix of ["11", "12", "13"]) {
      await provider.postReply(CONNECTED, {
        parentExternalId: ROOT_URI,
        body: "on it",
        replyId: `01a01fc6-0000-7000-8000-0000000000${suffix}`,
      });
    }

    // Thirty logins per five minutes is the published ceiling for one account,
    // which a busy thread would reach on its own if every reply logged in.
    const logins = calls.filter((call) => call.method === "com.atproto.server.createSession");
    expect(logins).toHaveLength(1);
  });

  it("refreshes an expired token instead of logging in again", async () => {
    const calls: Call[] = [];
    const provider = writingProvider(
      {
        "com.atproto.server.createSession": SESSION,
        "com.atproto.server.refreshSession": {
          ...SESSION,
          accessJwt: "access-2",
          refreshJwt: "refresh-2",
        },
        "app.bsky.feed.getPostThread": fixture,
        "com.atproto.repo.putRecord": (call: number) =>
          call === 1
            ? json({ error: "ExpiredToken" }, 401)
            : json({ uri: REFRESHED, cid: ROOT_CID }),
      },
      calls,
    );

    const posted = await provider.postReply(CONNECTED, {
      parentExternalId: ROOT_URI,
      body: "on it",
      replyId: "01a01fc6-0000-7000-8000-000000000014",
    });

    // The password is spent once. Everything after that runs on the refresh token,
    // which is what keeps a busy account away from the login ceiling.
    expect(posted.externalId).toBe(REFRESHED);
    expect(calls.filter((c) => c.method === "com.atproto.server.createSession")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "com.atproto.server.refreshSession")).toHaveLength(1);
  });

  it("reports a refused password without trying again", async () => {
    const calls: Call[] = [];
    const provider = writingProvider(
      {
        "app.bsky.feed.getPostThread": fixture,
        "com.atproto.server.createSession": () => json({ error: "AuthenticationRequired" }, 401),
      },
      calls,
    );

    await expect(
      provider.postReply(CONNECTED, {
        parentExternalId: ROOT_URI,
        body: "hi",
        replyId: "01a01fc6-0000-7000-8000-000000000003",
      }),
    ).rejects.toMatchObject({ code: "unauthorized", retryable: false });

    // A withdrawn password is answered once, not retried: only an expired access
    // token is recoverable, and that path goes through the refresh token.
    expect(calls.filter((c) => c.method === "com.atproto.server.createSession")).toHaveLength(1);
  });

  it("fails a reply when the deployment never set the secret", async () => {
    delete process.env["TEST_APP_PASSWORD"];
    const provider = writingProvider({
      "app.bsky.feed.getPostThread": fixture,
      "com.atproto.server.createSession": SESSION,
    });

    await expect(
      provider.postReply(CONNECTED, {
        parentExternalId: ROOT_URI,
        body: "hi",
        replyId: "01a01fc6-0000-7000-8000-000000000004",
      }),
    ).rejects.toMatchObject({ code: "unavailable", retryable: false });
  });
});

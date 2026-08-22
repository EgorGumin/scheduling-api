import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../db/client.js";
import { projectComments } from "../domain/ingest/projector.js";
import { fakeManifest, makeComment } from "../test/fake-provider.js";
import { resetDatabase, seedChannel, seedPost } from "../test/db.js";
import type { CapabilityDeclaration } from "../platform/capabilities.js";
import type { TriageState } from "../domain/triage.js";
import { encodeId } from "./ids.js";
import type { CommentPage, CommentView, Problem, ReplyStatus } from "./schemas.js";
import { buildServer } from "./server.js";

const db: Database = createDatabase();
const testManifests = { bluesky: fakeManifest };
const app = buildServer({ db, manifests: testManifests });

let tenantId: string;
let channelId: string;
let auth: Record<string, string>;

async function setUp(withCredential: boolean): Promise<void> {
  await resetDatabase(db);
  const seeded = await seedChannel(db, { withCredential });
  tenantId = seeded.tenantId;
  channelId = seeded.channelId;
  auth = { authorization: `Bearer ${tenantId}` };

  const postId = await seedPost(db, seeded);

  await projectComments(
    db,
    {
      channelId,
      tenantId,
      platform: "bluesky",
      subjectExternalId: "did:plc:test",
      actingAs: withCredential ? "did:plc:test" : null,
      credentialRef: withCredential ? "secret://demo" : null,
    },
    postId,
    [
      makeComment({ externalId: "a" }),
      makeComment({ externalId: "b" }),
      makeComment({ externalId: "c", parentExternalId: "b" }),
    ],
  );
}

beforeEach(() => setUp(true));

afterAll(async () => {
  await app.close();
  await db.close();
});

async function commentId(externalId: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(
    sql`SELECT id FROM comments WHERE external_id = ${externalId}`,
  );
  return encodeId("comment", rows[0]!.id);
}

describe("GET /v1/openapi.json", () => {
  it("is readable without a key, so the contract can be fetched before one exists", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/openapi.json" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ openapi: "3.1.0" });
  });
});

describe("GET /v1/comments", () => {
  it("returns the inbox newest first, with prefixed identifiers", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/comments", headers: auth });
    expect(response.statusCode).toBe(200);

    const body = response.json<CommentPage>();
    expect(body.data).toHaveLength(3);
    for (const comment of body.data) {
      expect(comment.id).toMatch(/^cmt_/);
      expect(comment.channelId).toMatch(/^chn_/);
      expect(comment.postId).toMatch(/^pst_/);
    }
  });

  it("pages by cursor without repeating or dropping a row", async () => {
    const first = await app.inject({ url: "/v1/comments?limit=2", headers: auth });
    const firstBody = first.json<CommentPage>();
    expect(firstBody.data).toHaveLength(2);
    const cursor = firstBody.page.nextCursor;
    expect(cursor).toBeTruthy();

    const second = await app.inject({
      url: `/v1/comments?limit=2&cursor=${encodeURIComponent(cursor!)}`,
      headers: auth,
    });
    const secondBody = second.json<CommentPage>();

    const ids = [...firstBody.data, ...secondBody.data].map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(3);
    expect(secondBody.page.nextCursor).toBeNull();
  });

  it("side-loads each post once, not once per comment", async () => {
    await db.execute(sql`UPDATE posts SET preview = 'the original post'`);

    const body = (await app.inject({ url: "/v1/comments", headers: auth })).json<CommentPage>();

    expect(body.data).toHaveLength(3);
    expect(body.included.posts).toHaveLength(1);
    expect(body.included.posts[0]).toMatchObject({ preview: "the original post" });
    expect(body.included.posts[0]?.id).toBe(body.data[0]?.postId);
  });

  it("offers no triage state on a reply of ours", async () => {
    // Regression: the inbox handed out `handling: "new"` on comments we sent.
    await db.execute(sql`UPDATE comments SET is_outbound = true WHERE external_id = 'a'`);

    const body = (await app.inject({ url: "/v1/comments", headers: auth })).json<CommentPage>();
    const ours = body.data.find((c) => c.direction === "outbound");

    expect(ours).toBeDefined();
    expect(ours?.state).toBeNull();
  });

  it("rejects an unknown query parameter instead of ignoring it", async () => {
    const response = await app.inject({ url: "/v1/comments?statuss=new", headers: auth });
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
  });

  it("refuses a comma list longer than a page can use", async () => {
    const ids = Array.from({ length: 51 }, () => encodeId("post", channelId)).join(",");
    const response = await app.inject({ url: `/v1/comments?postId=${ids}`, headers: auth });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a cursor it did not issue", async () => {
    const response = await app.inject({ url: "/v1/comments?cursor=bm90LW1pbmU", headers: auth });
    expect(response.statusCode).toBe(400);
  });

  it("needs an API key", async () => {
    expect((await app.inject({ url: "/v1/comments" })).statusCode).toBe(401);
  });

  it("shows another tenant nothing at all", async () => {
    const other = await seedChannel(db);
    const response = await app.inject({
      url: "/v1/comments",
      headers: { authorization: `Bearer ${other.tenantId}` },
    });
    expect(response.json<CommentPage>().data).toHaveLength(0);
  });
});

describe("GET /v1/comments/{commentId}", () => {
  it("returns one comment by its prefixed identifier", async () => {
    const id = await commentId("c");

    const response = await app.inject({ url: `/v1/comments/${id}`, headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json<CommentView>()).toMatchObject({ id, depth: 1, direction: "inbound" });
  });

  it("reports another tenant's comment as missing", async () => {
    const other = await seedChannel(db);
    const response = await app.inject({
      url: `/v1/comments/${await commentId("a")}`,
      headers: { authorization: `Bearer ${other.tenantId}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects an identifier of the wrong kind", async () => {
    const response = await app.inject({
      url: `/v1/comments/${encodeId("post", channelId)}`,
      headers: auth,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("capabilities and actions", () => {
  it("declares what the channel supports", async () => {
    const response = await app.inject({
      url: `/v1/comments/capabilities?channelId=${encodeId("channel", channelId)}`,
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<CapabilityDeclaration>().reply).toMatchObject({
      supported: true,
      text: { maxLength: 100 },
    });
  });

  it("says supported on the channel and unauthorized on the object at once", async () => {
    await setUp(false);

    const declaration = await app.inject({
      url: `/v1/comments/capabilities?channelId=${encodeId("channel", channelId)}`,
      headers: auth,
    });
    const inbox = await app.inject({ url: "/v1/comments", headers: auth });

    expect(declaration.json<CapabilityDeclaration>().reply.supported).toBe(true);
    expect(inbox.json<CommentPage>().data[0]?.actions.reply).toEqual({ status: "unauthorized" });
  });

  it("hides another tenant's channel behind a 404", async () => {
    const other = await seedChannel(db);
    const response = await app.inject({
      url: `/v1/comments/capabilities?channelId=${encodeId("channel", other.channelId)}`,
      headers: auth,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("replies", () => {
  it("accepts a reply and reports it queued", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/comments/${await commentId("a")}/replies`,
      headers: { ...auth, "idempotency-key": "k1", "x-actor-id": "agent-1" },
      payload: { body: "on it" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json<ReplyStatus>()).toMatchObject({ status: "queued" });
    expect(response.json<ReplyStatus>().id).toMatch(/^rpl_/);
  });

  it("reports a queued reply on its own route", async () => {
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/comments/${await commentId("a")}/replies`,
      headers: { ...auth, "idempotency-key": "k5" },
      payload: { body: "on it" },
    });

    const response = await app.inject({
      url: `/v1/replies/${accepted.json<ReplyStatus>().id}`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<ReplyStatus>()).toMatchObject({
      id: accepted.json<ReplyStatus>().id,
      status: "queued",
      externalId: null,
      postedAt: null,
      error: null,
    });
  });

  it("reports another tenant's reply as missing", async () => {
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/comments/${await commentId("a")}/replies`,
      headers: { ...auth, "idempotency-key": "k6" },
      payload: { body: "on it" },
    });

    const other = await seedChannel(db);
    const response = await app.inject({
      url: `/v1/replies/${accepted.json<ReplyStatus>().id}`,
      headers: { authorization: `Bearer ${other.tenantId}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns the same reply for a repeated key", async () => {
    const target = await commentId("a");
    const send = () =>
      app.inject({
        method: "POST",
        url: `/v1/comments/${target}/replies`,
        headers: { ...auth, "idempotency-key": "k2" },
        payload: { body: "same text" },
      });

    const first = await send();
    const second = await send();

    expect(second.statusCode).toBe(200);
    expect(second.json<ReplyStatus>().id).toBe(first.json<ReplyStatus>().id);
  });

  it("refuses a key reused for different content", async () => {
    const target = await commentId("a");
    await app.inject({
      method: "POST",
      url: `/v1/comments/${target}/replies`,
      headers: { ...auth, "idempotency-key": "k3" },
      payload: { body: "first" },
    });
    const conflict = await app.inject({
      method: "POST",
      url: `/v1/comments/${target}/replies`,
      headers: { ...auth, "idempotency-key": "k3" },
      payload: { body: "second" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<Problem>().title).toBe("idempotency_conflict");
  });

  it("insists on an idempotency key", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/comments/${await commentId("a")}/replies`,
      headers: auth,
      payload: { body: "no key" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an idempotency key longer than the column it lands in", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/comments/${await commentId("a")}/replies`,
      headers: { ...auth, "idempotency-key": "k".repeat(256) },
      payload: { body: "hi" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("names the reason a read-only channel cannot reply", async () => {
    await setUp(false);
    const response = await app.inject({
      method: "POST",
      url: `/v1/comments/${await commentId("a")}/replies`,
      headers: { ...auth, "idempotency-key": "k4" },
      payload: { body: "cannot" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().title).toBe("channel_unauthorized");
  });
});

describe("filters", () => {
  it("separates our own replies from what arrived", async () => {
    await db.execute(sql`UPDATE comments SET is_outbound = true WHERE external_id = 'a'`);

    const outbound = await app.inject({ url: "/v1/comments?direction=outbound", headers: auth });
    const inbound = await app.inject({ url: "/v1/comments?direction=inbound", headers: auth });

    expect(outbound.json<CommentPage>().data).toHaveLength(1);
    expect(inbound.json<CommentPage>().data).toHaveLength(2);
  });

  it("finds comments by the publishing module's own post identifier", async () => {
    await db.execute(sql`UPDATE posts SET publisher_post_id = 'pub-42'`);

    const matched = await app.inject({
      url: "/v1/comments?publisherPostId=pub-42",
      headers: auth,
    });
    const missed = await app.inject({
      url: "/v1/comments?publisherPostId=pub-43",
      headers: auth,
    });

    expect(matched.json<CommentPage>().data.length).toBeGreaterThan(0);
    expect(missed.json<CommentPage>().data).toEqual([]);
  });
});

describe("domain state", () => {
  it("records a decision and who made it", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/comments/${await commentId("a")}/state`,
      headers: { ...auth, "x-actor-id": "human-3" },
      payload: { handling: "escalated", note: "pricing question" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<TriageState>()).toMatchObject({
      handling: "escalated",
      handledBy: "human-3",
      note: "pricing question",
    });
  });

  it("clears who handled it when the comment is reopened", async () => {
    const id = await commentId("a");
    await app.inject({
      method: "PATCH",
      url: `/v1/comments/${id}/state`,
      headers: { ...auth, "x-actor-id": "human-3" },
      payload: { handling: "escalated" },
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/comments/${id}/state`,
      headers: { ...auth, "x-actor-id": "human-4" },
      payload: { handling: "new" },
    });

    expect(response.json<TriageState>()).toMatchObject({
      handling: "new",
      handledAt: null,
      handledBy: null,
    });
  });

  it("refuses to triage a reply of ours", async () => {
    const id = await commentId("a");
    await db.execute(sql`UPDATE comments SET is_outbound = true WHERE external_id = 'a'`);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/comments/${id}/state`,
      headers: auth,
      payload: { handling: "escalated" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects a handling value outside the vocabulary", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/comments/${await commentId("a")}/state`,
      headers: auth,
      payload: { handling: "maybe-later" },
    });
    expect(response.statusCode).toBe(400);
  });
});

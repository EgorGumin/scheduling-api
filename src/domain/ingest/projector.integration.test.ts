import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../../db/client.js";
import { makeComment } from "../../test/fake-provider.js";
import { resetDatabase, seedChannel, seedPost } from "../../test/db.js";
import type { ChannelContext } from "../../platform/types.js";
import { projectComments } from "./projector.js";

const db: Database = createDatabase();
let ctx: ChannelContext;
let postId: string;

beforeEach(async () => {
  await resetDatabase(db);
  const seeded = await seedChannel(db);
  ctx = {
    channelId: seeded.channelId,
    tenantId: seeded.tenantId,
    platform: "bluesky",
    subjectExternalId: "did:plc:test",
    credentialRef: null,
  };
  postId = await seedPost(db, seeded);
});

afterAll(async () => {
  await db.close();
});

async function rows<T extends Record<string, unknown>>(
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  return db.execute<T>(query) as unknown as Promise<T[]>;
}

/** A reply of ours that the platform has already accepted, under the given external id. */
async function seedOutboundReply(externalId: string, key: string): Promise<void> {
  const anchor = await db.execute<{ id: string }>(sql`
    INSERT INTO comments (tenant_id, channel_id, post_id, external_id, created_at_remote,
                          first_seen_at, last_synced_at)
    VALUES (${ctx.tenantId}::uuid, ${ctx.channelId}::uuid, ${postId}::uuid, ${`anchor-${key}`},
            now(), now(), now())
    RETURNING id
  `);
  await db.execute(sql`
    INSERT INTO outbound_replies (tenant_id, in_reply_to_comment_id, channel_id,
                                  idempotency_key, body, status, external_id, created_at)
    VALUES (${ctx.tenantId}::uuid, ${anchor[0]!.id}::uuid, ${ctx.channelId}::uuid,
            ${key}, 'our answer', 'posted', ${externalId}, now())
  `);
}

async function replyDisabled(externalId: string): Promise<boolean> {
  const [row] = await rows<{ reply_disabled: boolean }>(
    sql`SELECT reply_disabled FROM comments WHERE external_id = ${externalId}`,
  );
  return row!.reply_disabled;
}

describe("projector", () => {
  it("takes the reply restriction from the last read, including a read that saw none", async () => {
    const comment = makeComment({ externalId: "closed", replyDisabled: true });
    await projectComments(db, ctx, postId, [comment]);
    expect(await replyDisabled("closed")).toBe(true);

    // An unauthenticated read carries no viewer state, which stands for no
    // restriction rather than for the previous answer.
    await projectComments(db, ctx, postId, [{ ...comment, replyDisabled: null }]);
    expect(await replyDisabled("closed")).toBe(false);
  });

  it("refuses to make a comment its own parent", async () => {
    const loop = makeComment({ externalId: "loop", parentExternalId: "loop" });
    await projectComments(db, ctx, postId, [loop]);

    const [row] = await rows<{ parent_id: string | null; depth: number }>(
      sql`SELECT parent_id, depth FROM comments WHERE external_id = 'loop'`,
    );
    expect(row).toMatchObject({ parent_id: null, depth: 0 });
  });

  it("carries depth to the bottom of a deep chain that arrived backwards", async () => {
    const depth = 30;
    const chain = Array.from({ length: depth }, (_, level) =>
      makeComment({
        externalId: `n${level}`,
        parentExternalId: level === 0 ? null : `n${level - 1}`,
      }),
    );

    // Deepest first, so every comment is an orphan until the last one lands.
    for (const comment of [...chain].reverse()) {
      await projectComments(db, ctx, postId, [comment]);
    }

    const [deepest] = await rows<{ depth: number }>(
      sql`SELECT depth FROM comments WHERE external_id = ${`n${depth - 1}`}`,
    );
    expect(deepest!.depth).toBe(depth - 1);
  });

  it("is idempotent: a second pass inserts nothing and keeps cursors stable", async () => {
    const batch = [makeComment(), makeComment()];

    const first = await projectComments(db, ctx, postId, batch);
    const before = await rows<{ id: string; ingest_seq: string }>(
      sql`SELECT id, ingest_seq FROM comments ORDER BY ingest_seq`,
    );

    const second = await projectComments(db, ctx, postId, batch);
    const after = await rows<{ id: string; ingest_seq: string }>(
      sql`SELECT id, ingest_seq FROM comments ORDER BY ingest_seq`,
    );

    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(2);
    expect(after).toEqual(before);
  });

  it("links a child that arrived before its parent, and fixes its depth", async () => {
    const parent = makeComment({ externalId: "p1" });
    const child = makeComment({ externalId: "c1", parentExternalId: "p1" });
    const grandchild = makeComment({ externalId: "g1", parentExternalId: "c1" });

    // Deliberately reversed: nothing guarantees a parent arrives first.
    await projectComments(db, ctx, postId, [grandchild, child]);

    const orphans = await rows<{ external_id: string; parent_id: string | null; depth: number }>(
      sql`SELECT external_id, parent_id, depth FROM comments ORDER BY external_id`,
    );
    expect(orphans.find((r) => r.external_id === "g1")).toMatchObject({ depth: 1 });
    expect(orphans.find((r) => r.external_id === "c1")).toMatchObject({
      parent_id: null,
      depth: 0,
    });

    await projectComments(db, ctx, postId, [parent]);

    const linked = await rows<{ external_id: string; parent_id: string | null; depth: number }>(
      sql`SELECT external_id, parent_id, depth FROM comments ORDER BY depth, external_id`,
    );
    expect(linked.map((r) => [r.external_id, r.depth])).toEqual([
      ["p1", 0],
      ["c1", 1],
      ["g1", 2],
    ]);
  });

  it("keeps the newer version and ignores a stale one", async () => {
    const early = makeComment({
      externalId: "v1",
      body: "first",
      remoteVersion: new Date("2026-08-20T10:00:00Z"),
    });
    const late = { ...early, body: "edited", remoteVersion: new Date("2026-08-20T11:00:00Z") };
    const stale = { ...early, body: "stale", remoteVersion: new Date("2026-08-20T09:00:00Z") };

    await projectComments(db, ctx, postId, [early]);
    await projectComments(db, ctx, postId, [late]);
    await projectComments(db, ctx, postId, [stale]);

    const [row] = await rows<{ body: string }>(sql`SELECT body FROM comments WHERE external_id = 'v1'`);
    expect(row?.body).toBe("edited");
  });

  it("opens domain state for inbound comments only", async () => {
    await seedOutboundReply("ours-1", "key-1");

    await projectComments(
      db,
      ctx,
      postId,
      [makeComment({ externalId: "ours-1" }), makeComment({ externalId: "theirs-1" })],
    );

    const marked = await rows<{ external_id: string; is_outbound: boolean }>(
      sql`SELECT external_id, is_outbound FROM comments WHERE external_id IN ('ours-1','theirs-1')`,
    );
    expect(marked.find((r) => r.external_id === "ours-1")?.is_outbound).toBe(true);
    expect(marked.find((r) => r.external_id === "theirs-1")?.is_outbound).toBe(false);

    const states = await rows<{ external_id: string }>(sql`
      SELECT c.external_id FROM comment_states s JOIN comments c ON c.id = s.comment_id
       WHERE c.external_id IN ('ours-1','theirs-1')
    `);
    expect(states.map((r) => r.external_id)).toEqual(["theirs-1"]);
  });

  it("marks a reply of ours read back before its delivery was recorded", async () => {
    // The pass read the thread between the platform accepting our reply and
    // delivery writing down the id it came back with.
    await projectComments(db, ctx, postId, [makeComment({ externalId: "ours-2" })]);
    const [before] = await rows<{ is_outbound: boolean }>(
      sql`SELECT is_outbound FROM comments WHERE external_id = 'ours-2'`,
    );
    expect(before!.is_outbound).toBe(false);

    await seedOutboundReply("ours-2", "key-2");

    await projectComments(db, ctx, postId, [makeComment({ externalId: "ours-2" })]);

    const [after] = await rows<{ is_outbound: boolean }>(
      sql`SELECT is_outbound FROM comments WHERE external_id = 'ours-2'`,
    );
    expect(after!.is_outbound).toBe(true);
  });

  it("stores media references as the platform gave them", async () => {
    await projectComments(
      db,
      ctx,
      postId,
      [
        makeComment({
          externalId: "m1",
          media: [{ type: "image", url: "https://cdn.example/a.jpg", altText: "a cat" }],
        }),
      ],
    );

    const [row] = await rows<{ media: { type: string; url: string; altText?: string }[] }>(
      sql`SELECT media FROM comments WHERE external_id = 'm1'`,
    );
    expect(row?.media).toEqual([
      { type: "image", url: "https://cdn.example/a.jpg", altText: "a cat" },
    ]);
  });
});

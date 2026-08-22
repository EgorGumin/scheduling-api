import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../../db/client.js";
import { PlatformError } from "../../platform/types.js";
import { FakeProvider, makeComment } from "../../test/fake-provider.js";
import { resetDatabase, seedChannel } from "../../test/db.js";
import { reconcileChannel } from "./reconcile.js";

const db: Database = createDatabase();
let channelId: string;
let tenantId: string;

beforeEach(async () => {
  await resetDatabase(db);
  const seeded = await seedChannel(db);
  channelId = seeded.channelId;
  tenantId = seeded.tenantId;
});

afterAll(async () => {
  await db.close();
});

async function addPost(externalPostId: string, publishedAgoDays = 0): Promise<void> {
  await db.execute(sql`
    INSERT INTO posts (tenant_id, channel_id, external_post_id, published_at)
    VALUES (${tenantId}::uuid, ${channelId}::uuid, ${externalPostId},
            now() - ${`${publishedAgoDays} days`}::interval)
  `);
}

async function commentCount(externalPostId: string): Promise<number> {
  const rows = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM comments c
      JOIN posts p ON p.id = c.post_id
     WHERE p.external_post_id = ${externalPostId}
  `);
  return Number(rows[0]!.count);
}

async function readThrough(externalPostId: string): Promise<Date | null> {
  const rows = await db.execute<{ comments_read_through: Date | null }>(
    sql`SELECT comments_read_through FROM posts WHERE external_post_id = ${externalPostId}`,
  );
  return rows[0]?.comments_read_through ?? null;
}

async function channelStatus(): Promise<{ status: string; failures: number }> {
  const rows = await db.execute<{ status: string; consecutive_failures: number }>(sql`
    SELECT c.status, COALESCE(s.consecutive_failures, 0) AS consecutive_failures
      FROM channels c LEFT JOIN sync_state s ON s.channel_id = c.id
     WHERE c.id = ${channelId}::uuid
  `);
  return { status: rows[0]!.status, failures: Number(rows[0]!.consecutive_failures) };
}

/** Three passes where the channel's only post refuses to be read. */
async function degrade(): Promise<FakeProvider> {
  await addPost("post-a");
  const provider = new FakeProvider({
    failures: { "post-a": new PlatformError("unavailable", "down", true) },
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await reconcileChannel(db, provider, channelId);
  }
  return provider;
}

describe("reconcile", () => {
  it("walks the channel's posts and projects what it finds", async () => {
    await addPost("post-a");
    await addPost("post-b");

    const provider = new FakeProvider({
      threads: {
        "post-a": [makeComment({ postExternalId: "post-a" })],
        "post-b": [
          makeComment({ postExternalId: "post-b" }),
          makeComment({ postExternalId: "post-b" }),
        ],
      },
    });

    const report = await reconcileChannel(db, provider, channelId);

    expect(report.postsChecked).toBe(2);
    expect(report.inserted).toBe(3);
    expect(report.failures).toHaveLength(0);
  });

  it("reads a thread to the end, however many pages that takes", async () => {
    await addPost("post-a");
    const thread = Array.from({ length: 63 }, () => makeComment({ postExternalId: "post-a" }));
    const provider = new FakeProvider({ threads: { "post-a": thread }, pageSize: 2 });

    const report = await reconcileChannel(db, provider, channelId);

    expect(report.inserted).toBe(63);
    expect(provider.listCalls).toBe(32);
  });

  it("stops rather than looping when a platform repeats a cursor", async () => {
    await addPost("post-a");
    const provider = new FakeProvider({ threads: { "post-a": [] } });
    provider.listComments = async () => ({ items: [], cursor: "same" });

    const report = await reconcileChannel(db, provider, channelId);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.code).toBe("unknown");
  });

  it("finishes the channel when one post fails", async () => {
    await addPost("gone");
    await addPost("fine");

    const provider = new FakeProvider({
      failures: { gone: new PlatformError("not_found", "deleted upstream", false) },
      threads: { fine: [makeComment({ postExternalId: "fine" })] },
    });

    const report = await reconcileChannel(db, provider, channelId);

    expect(report.failures).toEqual([{ postExternalId: "gone", code: "not_found" }]);
    expect(report.inserted).toBe(1);
  });

  it("leaves a disconnected channel disconnected, however well the pass went", async () => {
    await addPost("post-a");
    await db.execute(
      sql`UPDATE channels SET status = 'disconnected' WHERE id = ${channelId}::uuid`,
    );

    // Reading needs no account on this platform, so a pass can succeed on a
    // channel whose account is gone. That says nothing about the account.
    await reconcileChannel(db, new FakeProvider({ threads: { "post-a": [] } }), channelId);

    expect((await channelStatus()).status).toBe("disconnected");
  });

  it("keeps a channel healthy when its posts are read but have nothing new", async () => {
    await addPost("gone");
    for (const id of ["quiet-1", "quiet-2", "quiet-3"]) {
      await addPost(id);
    }
    const provider = new FakeProvider({
      failures: { gone: new PlatformError("not_found", "deleted upstream", false) },
      threads: { "quiet-1": [], "quiet-2": [], "quiet-3": [] },
    });

    for (let pass = 0; pass < 3; pass += 1) {
      await reconcileChannel(db, provider, channelId);
    }

    expect(await channelStatus()).toEqual({ status: "active", failures: 0 });
  });

  it("degrades the channel after three passes that read nothing", async () => {
    const provider = await degrade();

    expect(await channelStatus()).toMatchObject({ status: "degraded", failures: 3 });
    expect(provider.listCalls).toBe(3);
  });

  it("brings a degraded channel back as soon as a pass stops failing", async () => {
    const provider = await degrade();

    // An empty thread: recovery is about the pass going through, not about
    // finding anything in it.
    provider.setScript({ threads: { "post-a": [] } });
    await reconcileChannel(db, provider, channelId);

    expect(await channelStatus()).toMatchObject({ status: "active", failures: 0 });
  });

  it("asks each post only for comments newer than that post's own last read", async () => {
    await addPost("post-a");
    const seen: (Date | undefined)[] = [];
    const provider = new FakeProvider({ threads: { "post-a": [] } });
    const original = provider.listComments.bind(provider);
    provider.listComments = async (ctx, query) => {
      seen.push(query.since);
      return original(ctx, query);
    };

    await reconcileChannel(db, provider, channelId);
    await reconcileChannel(db, provider, channelId);

    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBeInstanceOf(Date);
  });

  it("takes a comment the platform indexed late, however old its own timestamp says it is", async () => {
    await addPost("post-a");
    const provider = new FakeProvider({ threads: { "post-a": [] } });
    await reconcileChannel(db, provider, channelId);

    // Written days ago by its author's clock, handed to us only now. Creation
    // time is the author's to set; index time is what we asked the platform for.
    provider.setScript({
      threads: {
        "post-a": [
          makeComment({
            postExternalId: "post-a",
            createdAtRemote: new Date("2026-08-18T09:00:00Z"),
            remoteVersion: new Date(),
          }),
        ],
      },
    });
    await reconcileChannel(db, provider, channelId);

    expect(await commentCount("post-a")).toBe(1);
  });

  it("finds a comment left on a post the previous passes had no budget for", async () => {
    for (let age = 0; age < 5; age += 1) {
      await addPost(`post-${age}`, age);
    }
    const provider = new FakeProvider({ threads: {} });

    // Two passes over the newest posts only, while post-4 waits its turn.
    await reconcileChannel(db, provider, channelId, { maxPosts: 3 });
    const arrived = makeComment({
      postExternalId: "post-4",
      // Indexed before both passes, so a channel-wide position would already have
      // moved past it.
      remoteVersion: new Date(Date.now() - 10 * 60_000),
    });
    await reconcileChannel(db, provider, channelId, { maxPosts: 3 });

    provider.setScript({ threads: { "post-4": [arrived] } });
    for (let pass = 0; pass < 3; pass += 1) {
      await reconcileChannel(db, provider, channelId, { maxPosts: 4 });
    }

    expect(await commentCount("post-4")).toBe(1);
  });

  it("leaves a failed post's position alone, so the next pass asks from the same point", async () => {
    await addPost("post-a");
    const provider = new FakeProvider({ threads: { "post-a": [] } });
    await reconcileChannel(db, provider, channelId);
    const after = await readThrough("post-a");
    expect(after).not.toBeNull();

    provider.setScript({ failures: { "post-a": new PlatformError("unavailable", "down", true) } });
    await reconcileChannel(db, provider, channelId);

    expect(await readThrough("post-a")).toEqual(after);
  });

  it("keeps what an earlier read knew about the post when a later one carries less", async () => {
    await addPost("post-a");
    const described = {
      externalPostId: "post-a",
      preview: "hello",
      permalink: "https://example.test/post-a",
      publishedAt: new Date("2026-08-20T10:00:00Z"),
    };
    const provider = new FakeProvider({
      threads: { "post-a": [] },
      posts: { "post-a": described },
    });
    await reconcileChannel(db, provider, channelId);

    // An unauthenticated read, or one from an endpoint that answers with less.
    provider.setScript({
      threads: { "post-a": [] },
      posts: { "post-a": { ...described, preview: null, permalink: null } },
    });
    await reconcileChannel(db, provider, channelId);

    const rows = await db.execute<{ preview: string | null; permalink: string | null }>(
      sql`SELECT preview, permalink FROM posts WHERE external_post_id = 'post-a'`,
    );
    expect(rows[0]).toMatchObject({ preview: "hello", permalink: "https://example.test/post-a" });
  });
});

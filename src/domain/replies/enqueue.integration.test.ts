import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../../db/client.js";
import { fakeManifest } from "../../test/fake-provider.js";
import { seedChannel } from "../../test/db.js";
import { enqueueReply } from "./enqueue.js";
import { jobCount, replyRequest, seedReplyFixture, testManifests, type Fixture } from "./fixture.js";

const db: Database = createDatabase();
let fixture: Fixture;

beforeEach(async () => {
  fixture = await seedReplyFixture(db);
});

afterAll(async () => {
  await db.close();
});

const queue = (overrides: Partial<Parameters<typeof enqueueReply>[2]> = {}) =>
  enqueueReply(db, testManifests, replyRequest(fixture, overrides));

describe("enqueue", () => {
  it("commits the row and its delivery job together", async () => {
    const result = await queue();
    expect(result.outcome).toBe("queued");
    expect(await jobCount(db)).toBe(1);
  });

  it("returns the same reply for a repeated key without queueing more work", async () => {
    const first = await queue();
    const second = await queue();

    expect(second.outcome).toBe("duplicate");
    expect(second).toMatchObject({ replyId: (first as { replyId: string }).replyId });
    expect(await jobCount(db)).toBe(1);
  });

  it("refuses a key reused for different content", async () => {
    await queue();
    const conflict = await queue({ body: "something else" });
    expect(conflict).toMatchObject({ outcome: "rejected", reason: "idempotency_conflict" });
  });

  it("rejects a body past the platform limit, counting graphemes", async () => {
    const reply = fakeManifest.operations.reply;
    const limit = reply.supported ? reply.text.maxLength : 0;
    const result = await queue({ body: "👍".repeat(limit + 1) });
    expect(result).toMatchObject({ outcome: "rejected", reason: "body_too_long" });
  });

  it("rejects a reply that would exceed the platform's nesting limit", async () => {
    await db.execute(sql`UPDATE comments SET depth = 1 WHERE id = ${fixture.commentId}::uuid`);
    const result = await queue();
    expect(result).toMatchObject({ outcome: "rejected", reason: "depth_exceeded" });
  });

  it("refuses to queue anything on a read-only channel", async () => {
    fixture = await seedReplyFixture(db, false);
    const result = await queue();
    expect(result).toMatchObject({
      outcome: "rejected",
      reason: "action_unavailable",
      action: { status: "unauthorized" },
    });
    expect(await jobCount(db)).toBe(0);
  });

  it("answers a retried key from what was accepted, not from conditions since", async () => {
    const first = await queue();

    // The client never saw the first answer, and by now the account is gone.
    await db.execute(sql`UPDATE platform_credentials SET state = 'revoked'`);

    const retry = await queue();
    expect(retry).toMatchObject({
      outcome: "duplicate",
      replyId: (first as { replyId: string }).replyId,
    });
    expect(await jobCount(db)).toBe(1);
  });

  it("refuses to queue a reply to a comment closed to replies", async () => {
    await db.execute(
      sql`UPDATE comments SET reply_disabled = true WHERE id = ${fixture.commentId}::uuid`,
    );

    const result = await queue();

    expect(result).toMatchObject({ outcome: "rejected", action: { status: "forbidden_by_author" } });
    expect(await jobCount(db)).toBe(0);
  });

  it("does not leak another tenant's comment", async () => {
    const other = await seedChannel(db);
    const result = await queue({ tenantId: other.tenantId });
    expect(result).toEqual({ outcome: "unknown_comment" });
  });
});

import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../../db/client.js";
import { ProviderRegistry } from "../../platform/port.js";
import { PlatformError } from "../../platform/types.js";
import { deliverReply } from "./deliver.js";
import { enqueueReply, MAX_DELIVERY_ATTEMPTS } from "./enqueue.js";
import {
  replyRequest,
  replyRow,
  seedReplyFixture,
  testManifests,
  type Fixture,
} from "./fixture.js";

const db: Database = createDatabase();
let fixture: Fixture;

beforeEach(async () => {
  fixture = await seedReplyFixture(db);
});

afterAll(async () => {
  await db.close();
});

/** Enough failures that every attempt in a test hits one. */
const ALWAYS = 99;

async function queue(overrides: Partial<Parameters<typeof enqueueReply>[2]> = {}) {
  return enqueueReply(db, testManifests, replyRequest(fixture, overrides));
}

async function queueReply(
  overrides: Partial<Parameters<typeof enqueueReply>[2]> = {},
): Promise<string> {
  return ((await queue(overrides)) as { replyId: string }).replyId;
}

describe("delivery", () => {
  const attempt = { attempt: 1, maxAttempts: MAX_DELIVERY_ATTEMPTS };
  const lastAttempt = { attempt: MAX_DELIVERY_ATTEMPTS, maxAttempts: MAX_DELIVERY_ATTEMPTS };
  const secondAttempt = { attempt: 2, maxAttempts: MAX_DELIVERY_ATTEMPTS };

  it("records the external identifier and marks the comment answered", async () => {
    const replyId = await queueReply();

    await deliverReply(db, fixture.providers, { replyId }, attempt);

    expect(await replyRow(db, replyId)).toMatchObject({
      status: "posted",
      external_id: "ext-reply-1",
    });

    const states = await db.execute<{ handling: string; handled_by: string }>(
      sql`SELECT handling, handled_by FROM comment_states WHERE comment_id = ${fixture.commentId}::uuid`,
    );
    expect(states[0]).toMatchObject({ handling: "answered", handled_by: "agent-7" });
  });

  it("throws on a retryable failure so the worker schedules another attempt", async () => {
    fixture.provider.setScript({ failReplies: 1 });
    const replyId = await queueReply();

    await expect(deliverReply(db, fixture.providers, { replyId }, attempt)).rejects.toThrow(
      PlatformError,
    );

    expect(await replyRow(db, replyId)).toMatchObject({
      status: "retrying",
      error_code: "unavailable",
    });
  });

  it("posts on the attempt after a retryable failure", async () => {
    fixture.provider.setScript({ failReplies: 1 });
    const replyId = await queueReply();
    await expect(deliverReply(db, fixture.providers, { replyId }, attempt)).rejects.toThrow(
      PlatformError,
    );

    await deliverReply(db, fixture.providers, { replyId }, secondAttempt);

    expect(await replyRow(db, replyId)).toMatchObject({ status: "posted" });
  });

  it("does not throw on a permanent rejection, and stops trying", async () => {
    fixture.provider.setScript({
      failReplies: ALWAYS,
      replyError: new PlatformError("permission_denied", "scope missing", false),
    });
    const replyId = await queueReply();

    await expect(
      deliverReply(db, fixture.providers, { replyId }, attempt),
    ).resolves.toBeUndefined();
    expect(await replyRow(db, replyId)).toMatchObject({
      status: "failed",
      error_code: "permission_denied",
    });
  });

  it("downgrades the credential when the platform refuses on the account", async () => {
    fixture.provider.setScript({
      failReplies: ALWAYS,
      replyError: new PlatformError("permission_denied", "scope missing", false),
    });
    const replyId = await queueReply();

    await deliverReply(db, fixture.providers, { replyId }, attempt);

    const credentials = await db.execute<{ state: string; state_changed_at: Date | null }>(
      sql`SELECT state, state_changed_at FROM platform_credentials`,
    );
    expect(credentials[0]!.state).toBe("insufficient_scope");
    expect(credentials[0]!.state_changed_at).not.toBeNull();

    // The refusal now shows on every comment of the channel, before another call is spent.
    expect(await queue({ idempotencyKey: "key-2" })).toMatchObject({
      action: { status: "insufficient_scope" },
    });
  });

  it("gives up on the last attempt instead of asking for one more", async () => {
    fixture.provider.setScript({ failReplies: ALWAYS });
    const replyId = await queueReply();

    await expect(
      deliverReply(db, fixture.providers, { replyId }, lastAttempt),
    ).resolves.toBeUndefined();
    expect(await replyRow(db, replyId)).toMatchObject({ status: "failed" });
  });

  it("fails a reply for a platform this deployment has no adapter for", async () => {
    const replyId = await queueReply();

    const empty = new ProviderRegistry([]);
    await expect(deliverReply(db, empty, { replyId }, attempt)).resolves.toBeUndefined();

    expect(await replyRow(db, replyId)).toMatchObject({
      status: "failed",
      error_code: "unavailable",
    });
  });

  it("credits the actor who asked for the reply, not the one who escalated it", async () => {
    await db.execute(sql`
      UPDATE comment_states SET handling = 'escalated', handled_at = now(), handled_by = 'human-A'
       WHERE comment_id = ${fixture.commentId}::uuid
    `);

    const replyId = await queueReply({ requestedBy: "agent-B" });
    await deliverReply(db, fixture.providers, { replyId }, attempt);

    const [state] = await db.execute<{ handling: string; handled_by: string }>(
      sql`SELECT handling, handled_by FROM comment_states WHERE comment_id = ${fixture.commentId}::uuid`,
    );
    expect(state).toMatchObject({ handling: "answered", handled_by: "agent-B" });
  });

  it("is safe to run twice: a delivered reply is not sent again", async () => {
    const replyId = await queueReply();

    await deliverReply(db, fixture.providers, { replyId }, attempt);
    await deliverReply(db, fixture.providers, { replyId }, secondAttempt);

    expect(fixture.provider.posted).toHaveLength(1);
  });
});

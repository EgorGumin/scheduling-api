import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { ProviderRegistry } from "../../platform/port.js";
import { FakeProvider, fakeManifest, makeComment } from "../../test/fake-provider.js";
import { resetDatabase, seedChannel, seedPost } from "../../test/db.js";
import { projectComments } from "../ingest/projector.js";
import type { enqueueReply } from "./enqueue.js";

export const testManifests = { bluesky: fakeManifest };

export interface Fixture {
  tenantId: string;
  commentId: string;
  provider: FakeProvider;
  providers: ProviderRegistry;
}

/** A channel with one inbound comment to reply to, and a fake standing in for its platform. */
export async function seedReplyFixture(db: Database, withCredential = true): Promise<Fixture> {
  await resetDatabase(db);
  const seeded = await seedChannel(db, { withCredential });

  const ctx = {
    channelId: seeded.channelId,
    tenantId: seeded.tenantId,
    platform: "bluesky" as const,
    subjectExternalId: "did:plc:test",
    credentialRef: withCredential ? "secret://demo" : null,
  };
  const postId = await seedPost(db, seeded);
  await projectComments(db, ctx, postId, [makeComment({ externalId: "target" })]);

  const rows = await db.execute<{ id: string }>(
    sql`SELECT id FROM comments WHERE external_id = 'target'`,
  );

  // The seeded channel is bluesky, so the fake stands in under that name.
  const provider = new FakeProvider({}, "bluesky");
  return {
    tenantId: seeded.tenantId,
    commentId: rows[0]!.id,
    provider,
    providers: new ProviderRegistry([provider]),
  };
}

export function replyRequest(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof enqueueReply>[2]> = {},
): Parameters<typeof enqueueReply>[2] {
  return {
    tenantId: fixture.tenantId,
    commentId: fixture.commentId,
    idempotencyKey: "key-1",
    body: "thanks for asking",
    requestedBy: "agent-7",
    ...overrides,
  };
}

export async function replyRow(db: Database, id: string) {
  const rows = await db.execute<{
    status: string;
    external_id: string | null;
    error_code: string | null;
  }>(sql`SELECT status, external_id, error_code FROM outbound_replies WHERE id = ${id}::uuid`);
  return rows[0]!;
}

export async function jobCount(db: Database): Promise<number> {
  const rows = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE task_identifier = 'deliver-reply'`,
  );
  return Number(rows[0]!.count);
}

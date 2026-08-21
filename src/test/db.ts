import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { fakeManifest } from "./fake-provider.js";

/** Taken from the fake rather than repeated, so a seeded channel can always reply to it. */
const fakeReply = fakeManifest.operations.reply;
const FAKE_SCOPES = fakeReply.supported ? fakeReply.requiredScopes : [];

const TABLES = [
  "comment_states",
  "outbound_replies",
  "comments",
  "posts",
  "sync_state",
  "channels",
  "platform_credentials",
] as const;

/** RESTART IDENTITY resets ingest_seq, so cursor assertions stay deterministic. */
export async function resetDatabase(db: Database): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`));
}

export interface SeededChannel {
  readonly tenantId: string;
  readonly channelId: string;
}

export async function seedChannel(
  db: Database,
  options: { withCredential?: boolean; grantedScopes?: readonly string[] | null } = {},
): Promise<SeededChannel> {
  const tenant = await db.execute<{ id: string }>(sql`SELECT uuidv7() AS id`);
  const tenantId = tenant[0]!.id;

  const scopes =
    options.grantedScopes === undefined ? FAKE_SCOPES : options.grantedScopes;
  const scopesJson = scopes === null ? null : JSON.stringify(scopes);

  let credentialId: string | null = null;
  if (options.withCredential === true) {
    const rows = await db.execute<{ id: string }>(sql`
      INSERT INTO platform_credentials (tenant_id, platform, credential_ref, granted_scopes)
      SELECT ${tenantId}::uuid, 'bluesky', 'secret://demo',
             CASE WHEN ${scopesJson}::jsonb IS NULL THEN NULL
                  ELSE ARRAY(SELECT jsonb_array_elements_text(${scopesJson}::jsonb)) END
      RETURNING id
    `);
    credentialId = rows[0]!.id;
  }

  const channel = await db.execute<{ id: string }>(sql`
    INSERT INTO channels (tenant_id, platform, subject_external_id, subject_handle, credential_id, status)
    VALUES (${tenantId}::uuid, 'bluesky', 'did:plc:test', 'test.bsky.social',
            ${credentialId}::uuid, 'active')
    RETURNING id
  `);

  return { tenantId, channelId: channel[0]!.id };
}

/** Posts are registered before a sync reads them, so tests that project comments need one. */
export async function seedPost(
  db: Database,
  channel: SeededChannel,
  externalPostId = "post-1",
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO posts (tenant_id, channel_id, external_post_id)
    VALUES (${channel.tenantId}::uuid, ${channel.channelId}::uuid, ${externalPostId})
    RETURNING id
  `);
  return rows[0]!.id;
}

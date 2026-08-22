/**
 * Creates a channel and records the posts of the account it watches, so a fresh clone
 * has a tenant, an api key, and something for the worker to read.
 *
 *   npm run seed                watches `BLUESKY_HANDLE`'s posts, or a public
 *                               account's posts when `BLUESKY_HANDLE` is unset
 *   npm run seed -- bsky.app    watches bsky.app's posts
 *
 * The channel replies as `BLUESKY_HANDLE` whenever `BLUESKY_APP_PASSWORD` is set, no
 * matter whose posts it watches. With no password it cannot reply at all:
 * `credential_id` stays null, which is a supported state, and every reply is refused
 * with `channel_unauthorized`.
 */
import { sql } from "drizzle-orm";
import { v7 as uuidV7 } from "uuid";
import { createDatabase, type Database } from "../src/db/client.js";
import { openAppView } from "../src/platform/bluesky/appview.js";
import { encodeId } from "../src/api/ids.js";

const handle = process.argv[2] ?? process.env["BLUESKY_HANDLE"] ?? "bloomberg.com";

/** The row holds this reference; the password itself stays in the environment. */
const PASSWORD_REF = "secret://env/BLUESKY_APP_PASSWORD";

const password = process.env["BLUESKY_APP_PASSWORD"];
const account = process.env["BLUESKY_HANDLE"];
if (password !== undefined && account === undefined) {
  throw new Error(
    "BLUESKY_APP_PASSWORD is set without BLUESKY_HANDLE, so there is no account to reply as",
  );
}

/** Undefined makes the channel read-only. */
const replyingAs = password === undefined ? undefined : account;

const db = createDatabase();

const appView = openAppView();
const { data: { did } } = await appView.com.atproto.identity.resolveHandle({ handle });

const tenantId = uuidV7();

const credentialId = await connectAccount(tenantId);

const channel = await db.execute<{ id: string; tenant_id: string }>(sql`
  INSERT INTO channels (tenant_id, platform, subject_external_id, subject_handle,
                        credential_id, status, capture_started_at)
  VALUES (${tenantId}::uuid, 'bluesky', ${did}, ${handle}, ${credentialId}::uuid, 'active', now())
  ON CONFLICT (tenant_id, platform, subject_external_id) DO UPDATE
     SET subject_handle = excluded.subject_handle,
         credential_id = excluded.credential_id
  RETURNING id, tenant_id
`);

const row = channel[0]!;
const discovered = await discoverPosts(db, row.tenant_id, row.id, did);
await db.close();

console.log(`watching  ${handle}  (${did})`);
console.log(`replying  ${replyingAs ?? "no account connected, replies are refused"}`);
console.log(`posts     ${discovered}`);
console.log(`channelId ${encodeId("channel", row.id)}`);
console.log(`apiKey    ${row.tenant_id}`);
console.log("");
console.log("Now run:  npm run worker   then read /v1/comments with that key");

/** Stands in for the account-connection module, which owns this row everywhere else. */
async function connectAccount(tenant: string): Promise<string | null> {
  if (replyingAs === undefined) {
    return null;
  }

  const resolved = await appView.com.atproto.identity.resolveHandle({ handle: replyingAs });

  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO platform_credentials (tenant_id, platform, actor_external_id, credential_ref, state)
    VALUES (${tenant}::uuid, 'bluesky', ${resolved.data.did}, ${PASSWORD_REF}, 'ok')
    RETURNING id
  `);
  return rows[0]!.id;
}

/**
 * Finding a channel's posts belongs to the publishing side of the product, which
 * writes the row at the moment it sends the post. A channel watching an account we
 * do not publish for has no such row, and the reconciler only sweeps posts that
 * already exist.
 */
async function discoverPosts(
  database: Database,
  tenant: string,
  channelId: string,
  actor: string,
): Promise<number> {
  const feed = await appView.app.bsky.feed.getAuthorFeed({ actor, limit: 40 });

  const posts = feed.data.feed.map((entry) => ({
    externalPostId: entry.post.uri,
    publishedAt: entry.post.indexedAt,
  }));
  if (posts.length === 0) {
    return 0;
  }

  const inserted = await database.execute<{ id: string }>(sql`
    INSERT INTO posts (tenant_id, channel_id, external_post_id, published_at)
    SELECT ${tenant}::uuid, ${channelId}::uuid,
           entry->>'externalPostId', (entry->>'publishedAt')::timestamptz
      FROM jsonb_array_elements(${JSON.stringify(posts)}::jsonb) AS entry
    ON CONFLICT (channel_id, external_post_id) DO NOTHING
    RETURNING id
  `);

  return inserted.length;
}

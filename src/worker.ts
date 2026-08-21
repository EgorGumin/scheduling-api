import { run, type Task } from "graphile-worker";
import { ne, sql } from "drizzle-orm";
import { databaseUrl } from "./config.js";
import { createDatabase, type Database } from "./db/client.js";
import { channels } from "./db/schema.js";
import { BlueskyProvider } from "./platform/bluesky/adapter.js";
import { ProviderRegistry } from "./platform/port.js";
import type { Platform } from "./platform/types.js";
import { reconcileChannel } from "./domain/ingest/reconcile.js";
import { deliverReply, type DeliverPayload } from "./domain/replies/deliver.js";

/** Jobs running at once in this process, across all tasks. */
const CONCURRENCY = 4;

/** How often every channel is swept. The delay a comment can sit unseen starts here. */
const SWEEP = "*/5 * * * *";

function buildTasks(db: Database, providers: ProviderRegistry): Record<string, Task> {
  return {
    "deliver-reply": async (payload, helpers) => {
      const { replyId } = payload as DeliverPayload;
      await deliverReply(db, providers, { replyId }, {
        attempt: helpers.job.attempts,
        maxAttempts: helpers.job.max_attempts,
      });
    },

    "reconcile-channel": async (payload) => {
      const { channelId, platform } = payload as { channelId: string; platform: Platform };
      await reconcileChannel(db, providers.get(platform), channelId);
    },

    // One job per channel: a slow channel delays only itself, and a retry redoes
    // only that channel. Channels on a platform this deployment cannot reach are
    // left alone, since the job would fail on the registry and record nothing.
    "reconcile-due": async (_payload, helpers) => {
      const rows = await db
        .select({ id: channels.id, platform: sql<Platform>`${channels.platform}` })
        .from(channels)
        .where(ne(channels.status, "disconnected"));
      for (const row of rows) {
        if (!providers.has(row.platform)) {
          continue;
        }
        await helpers.addJob(
          "reconcile-channel",
          { channelId: row.id, platform: row.platform },
          { jobKey: `reconcile:${row.id}` },
        );
      }
    },
  };
}

async function startWorker(): Promise<void> {
  const db = createDatabase();
  const providers = new ProviderRegistry([new BlueskyProvider()]);

  const runner = await run({
    connectionString: databaseUrl,
    concurrency: CONCURRENCY,
    taskList: buildTasks(db, providers),
    crontab: `${SWEEP} reconcile-due\n`,
  });

  await runner.promise;
}

await startWorker();

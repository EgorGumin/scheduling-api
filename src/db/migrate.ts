import { runMigrations } from "graphile-worker";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { databaseUrl } from "../config.js";

const client = postgres(databaseUrl, { max: 1 });
await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
await client.end();

// The worker keeps its own schema. Installing it here means one command brings
// up everything the application needs.
await runMigrations({ connectionString: databaseUrl });

console.log("migrations applied");

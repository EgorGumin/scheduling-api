import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { databaseUrl } from "../config.js";

const client = postgres(databaseUrl, { max: 1 });
await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
await client.end();

console.log("migrations applied");

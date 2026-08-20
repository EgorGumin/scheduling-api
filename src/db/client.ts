import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { databaseUrl } from "../config.js";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(url: string = databaseUrl) {
  const client = postgres(url, { max: 10 });
  return Object.assign(drizzle(client, { schema, casing: "snake_case" }), {
    close: () => client.end(),
  });
}

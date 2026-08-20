import { defineConfig } from "drizzle-kit";
import { databaseUrl } from "./src/config.js";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: { url: databaseUrl },
});

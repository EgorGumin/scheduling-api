const DEFAULT_DATABASE_URL = "postgres://comments:comments@localhost:5433/comments";

export const databaseUrl = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;

export const port = Number.parseInt(process.env["PORT"] ?? "3000", 10);

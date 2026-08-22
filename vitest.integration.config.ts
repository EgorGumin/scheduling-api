import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  test: {
    include: ["src/**/*.integration.test.ts"],
    // Vitest does not read `.env.test` on its own.
    env: loadEnv(mode, process.cwd(), ""),
    // One database, so files must not truncate each other's rows concurrently.
    fileParallelism: false,
    testTimeout: 20_000,
  },
}));

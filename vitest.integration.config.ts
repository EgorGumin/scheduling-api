import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    // One database, so files must not truncate each other's rows concurrently.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});

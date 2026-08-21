import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  test: {
    include: ["src/**/*.live.test.ts"],
    testTimeout: 20_000,
    // The empty prefix takes plain names too; without it only `VITE_` ones would
    // arrive, and the account these tests need would look unconfigured.
    env: loadEnv(mode, process.cwd(), ""),
  },
}));

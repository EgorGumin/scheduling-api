import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Tests that reach a real platform live apart, so `npm test` stays hermetic
    // and offline. Run them with `npm run test:live`.
    exclude: ["**/*.live.test.ts", "**/*.integration.test.ts", "**/node_modules/**"],
  },
});

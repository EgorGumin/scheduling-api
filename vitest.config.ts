import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Tests that need a platform or a database live apart, so `npm test` needs
    // neither. Run those with `npm run test:live` and `npm run test:integration`.
    exclude: ["**/*.live.test.ts", "**/*.integration.test.ts", "**/node_modules/**"],
  },
});

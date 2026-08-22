import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default defineConfig([
  globalIgnores(["node_modules", "drizzle", "**/__fixtures__"]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A key dropped by rest destructuring is never read.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    // Test doubles use `async` to reject on a throw.
    files: ["**/*.test.ts", "src/test/**"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  { files: ["eslint.config.js"], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
]);

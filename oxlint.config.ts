import { strict } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core, strict],
  ignorePatterns: ["vendor/**", "**/dist/**", "**/*.generated.ts"],
  overrides: [
    {
      files: ["**/*.test.ts", "**/test/**"],
      rules: {
        // bun:test types `expect(...).rejects` matchers as void, but they must
        // be awaited; removing the await silently skips the assertion.
        "typescript/await-thenable": "off",
      },
    },
  ],
  rules: {
    // Namespace modules use named declarations; Effect.gen uses anonymous generators.
    "func-names": ["error", "as-needed", { generators: "never" }],
    "func-style": ["error", "declaration", { allowArrowFunctions: true }],
    // Effect generators exit early with a bare `return;` and fail with
    // `return yield* Effect.fail(...)`; requiring one return shape fights that.
    "typescript/consistent-return": "off",
    // Effect.sync/Effect.try thunks idiomatically return void calls:
    // Effect.sync(() => closeSync(fd)).
    "typescript/no-confusing-void-expression": "off",
    // Report paths and limits count Unicode code points to match SQLite substr;
    // [...text] is the intended split. Other misused spreads stay errors.
    "typescript/no-misused-spread": [
      "error",
      { allow: [{ from: "lib", name: "string" }] },
    ],
    // Effect.forEach/map/flatMap take (self, f, options); they are not Array methods.
    "unicorn/no-array-method-this-argument": "off",
  },
});

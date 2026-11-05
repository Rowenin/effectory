import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: ["vendor/**", "**/dist/**", "**/*.generated.ts"],
  rules: {
    // Namespace modules use named declarations; Effect.gen uses anonymous generators.
    "func-names": ["error", "as-needed", { generators: "never" }],
    "func-style": ["error", "declaration", { allowArrowFunctions: true }],
    // Effect.forEach/map/flatMap take (self, f, options); they are not Array methods.
    "unicorn/no-array-method-this-argument": "off",
  },
});

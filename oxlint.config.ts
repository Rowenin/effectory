import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: ["**/dist/**"],
  rules: {
    // Effect.forEach/map/flatMap take (self, f, options); they are not Array methods.
    "unicorn/no-array-method-this-argument": "off",
  },
});

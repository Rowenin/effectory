import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    "vendor/**",
    "**/dist/**",
    "bun.lock",
    "CHANGELOG.md",
    "**/*.generated.ts",
  ],
});

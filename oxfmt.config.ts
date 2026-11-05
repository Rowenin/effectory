import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: ["vendor/**", "**/dist/**", "bun.lock", "**/*.generated.ts"],
});

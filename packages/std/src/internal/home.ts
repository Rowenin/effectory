import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/** `$EFFECTORY_HOME`, default `~/.effectory`: where std Resources keep local state. */
export const effectoryHome = () =>
  process.env.EFFECTORY_HOME ?? path.join(homedir(), ".effectory");

/** A short, stable digest of `parts`, for directory names. */
export const digest = (parts: readonly string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);

/** A filesystem-safe slug of `value`, for readable directory names. */
export const slug = (value: string) =>
  value
    .replaceAll(/[^\w.-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 40) || "x";

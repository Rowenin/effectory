import type { Writable } from "node:stream";

import { Effect } from "effect";

import { writeTextLine } from "./text-line.ts";

/** Await each write before pulling another frame from the RPC stream. */
export function writeJsonLine(
  value: unknown,
  output: Writable = process.stdout
) {
  return Effect.suspend(() => writeTextLine(JSON.stringify(value), output));
}

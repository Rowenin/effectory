import { rename } from "node:fs/promises";

/** Publish readiness atomically so the parent cannot observe a partial JSON file. */
export async function writeReady(filename: string, body: string) {
  const temporary = `${filename}.tmp`;
  await Bun.write(temporary, body);
  await rename(temporary, filename);
}

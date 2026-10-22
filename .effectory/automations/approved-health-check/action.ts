import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import pathModule from "node:path";

import { Effect } from "effect";

export const reportPath = (workspace: string, runId: string) =>
  pathModule.resolve(
    workspace,
    ".effectory/state/approved-health-check",
    `${createHash("sha256").update(runId).digest("hex")}.json`
  );

// Publish complete bytes atomically. A replay accepts only an identical report.
export const writeReport = (path: string, value: unknown) =>
  Effect.tryPromise({
    catch: String,
    try: async () => {
      const bytes = `${JSON.stringify(value)}\n`;
      await mkdir(pathModule.dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        try {
          await link(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }
          if ((await readFile(path, "utf-8")) !== bytes) {
            throw new Error(
              `Refusing to overwrite conflicting approved report: ${path}`,
              { cause: error }
            );
          }
        }
      } finally {
        try {
          await unlink(temporary);
        } catch {
          // A failed temporary-file creation leaves nothing to remove.
        }
      }
      return path;
    },
  });

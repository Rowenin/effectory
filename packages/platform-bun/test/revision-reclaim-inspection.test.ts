import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Exit } from "effect";

import { ownershipLayer } from "../src/ownership.ts";
import { inspectReclaimDependencies } from "../src/revision-reclaim-dependencies.ts";
import { withRuntimeInspection } from "../src/upgrade-storage.ts";

function snapshot(directory: string) {
  return Object.fromEntries(
    readdirSync(directory)
      .filter((name) => !name.startsWith("state.sqlite.owner"))
      .toSorted()
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(path.join(directory, name)))
          .digest("hex"),
      ])
  );
}

test.each(["valid", "orphan"])(
  "private reclamation dependency inspection of a killed writer preserves SQLite/WAL/SHM on %s records",
  async (fault) => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "effectory-reclaim-copy-")
    );
    const filename = path.join(directory, "state.sqlite");
    let captured = "";
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "fixtures/revision-reclaim-writer.ts"),
          filename,
          fault,
        ],
        { stderr: "pipe", stdout: "ignore" }
      );
      const stderr = new Response(child.stderr).text();
      await child.exited;
      expect(child.signalCode, await stderr).toBe("SIGKILL");
      expect(readFileSync(`${filename}-wal`).length).toBeGreaterThan(32);
      const before = snapshot(directory);
      const exit = await Effect.runPromiseExit(
        withRuntimeInspection(filename, (inspection) => {
          ({ captured } = inspection);
          return inspectReclaimDependencies(
            inspection.database,
            ["a".repeat(64), "b".repeat(64)],
            "a".repeat(64)
          );
        }).pipe(Effect.provide(ownershipLayer(`${filename}.owner`)))
      );
      if (fault === "valid") {
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          expect(exit.value.protected.map((p) => p.revision)).toEqual([
            "a".repeat(64),
            "b".repeat(64),
          ]);
        }
      } else {
        expect(Exit.isFailure(exit)).toBe(true);
      }
      expect(snapshot(directory)).toEqual(before);
      expect(captured).not.toBe("");
      expect(existsSync(path.dirname(path.dirname(captured)))).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
);

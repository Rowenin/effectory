import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Cause, Effect, Exit, Option } from "effect";

import { ownershipLayer } from "../src/ownership.ts";
import {
  withUpgradeInspection,
  withRuntimeInspection,
} from "../src/upgrade-storage.ts";

async function fixture(mode = "append") {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-upgrade-storage-test-")
  );
  const filename = path.join(directory, "state.sqlite");
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "fixtures/upgrade-storage-writer.ts"),
      filename,
      mode,
    ],
    { stderr: "pipe", stdout: "ignore" }
  );
  const stderr = new Response(child.stderr).text();
  await child.exited;
  expect(child.signalCode, await stderr).toBe("SIGKILL");
  expect(readFileSync(`${filename}-wal`).length).toBeGreaterThan(32);
  return { directory, filename };
}
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

const markerView = (inspection: { readonly database: Database }) =>
  Effect.sync(() =>
    inspection.database.query("SELECT value FROM marker").get()
  );

test("same-build startup can inspect SQLite's reused WAL while upgrade certification still refuses ambiguous tails", async () => {
  const { directory, filename } = await fixture("reused");
  try {
    const before = snapshot(directory);
    const result = await Effect.runPromise(
      withRuntimeInspection(filename, markerView).pipe(
        Effect.provide(ownershipLayer(`${filename}.owner`))
      )
    );
    expect(result).toEqual({ value: "committed-before-kill" });
    const transition = await Effect.runPromiseExit(
      withUpgradeInspection(filename, markerView).pipe(
        Effect.provide(ownershipLayer(`${filename}.owner`))
      )
    );
    expect(Exit.isFailure(transition)).toBe(true);
    if (Exit.isFailure(transition)) {
      const error = Cause.findErrorOption(transition.cause);
      expect(
        Option.isSome(error) && "code" in error.value && error.value.code
      ).toBe("RevisionUnavailable");
    }
    expect(snapshot(directory)).toEqual(before);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("upgrade inspection preserves crash-left committed WAL and source bytes without application or migrations", async () => {
  const { directory, filename } = await fixture();
  let captured = "";
  try {
    const before = snapshot(directory);
    const result = await Effect.runPromise(
      withUpgradeInspection(filename, (inspection) =>
        Effect.sync(() => {
          ({ captured } = inspection);
          expect(readFileSync(`${captured}-wal`)).toEqual(
            readFileSync(`${filename}-wal`)
          );
          expect(inspection.files.map((file) => file.suffix)).toContain("-shm");
          expect(() =>
            inspection.database.exec("UPDATE marker SET value='changed'")
          ).toThrow();
          return inspection.database.query("SELECT value FROM marker").get();
        })
      ).pipe(Effect.provide(ownershipLayer(`${filename}.owner`)))
    );
    expect(result).toEqual({ value: "committed-before-kill" });
    expect(snapshot(directory)).toEqual(before);
    expect(captured).not.toBe("");
    expect(existsSync(path.dirname(path.dirname(captured)))).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test.each([
  "header",
  "frame",
  "truncate",
  "header-only",
  "partial-tail",
  "journal",
] as const)(
  "upgrade inspection refuses %s uncertainty without silently normalizing source history",
  async (fault) => {
    const { directory, filename } = await fixture();
    try {
      const original = readFileSync(`${filename}-wal`);
      if (fault === "header") {
        original[24] = ((original[24] ?? 0) + 1) % 256;
      }
      if (fault === "frame") {
        original[original.length - 1] = ((original.at(-1) ?? 0) + 1) % 256;
      }
      if (fault === "journal") {
        writeFileSync(`${filename}-journal`, "uncertain rollback data");
      }
      let damaged = original;
      if (fault === "truncate") {
        damaged = original.subarray(0, -1);
      }
      if (fault === "header-only") {
        damaged = original.subarray(0, 32);
      }
      if (fault === "partial-tail") {
        damaged = Buffer.concat([original, Buffer.from("partial")]);
      }
      writeFileSync(`${filename}-wal`, damaged);
      const before = snapshot(directory);
      let queried = false;
      const exit = await Effect.runPromiseExit(
        withUpgradeInspection(filename, () =>
          Effect.sync(() => {
            queried = true;
          })
        ).pipe(Effect.provide(ownershipLayer(`${filename}.owner`)))
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(
          Option.isSome(error) &&
            error.value._tag === "OperationError" &&
            error.value.code
        ).toBe("RevisionUnavailable");
      }
      expect(queried).toBe(false);
      expect(snapshot(directory)).toEqual(before);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
);

test("checkpointed storage inspection is scope-owned even when the caller fails", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-upgrade-clean-test-")
  );
  const filename = path.join(directory, "state.sqlite");
  let captured = "";
  try {
    const db = new Database(filename);
    db.exec(
      "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('clean')"
    );
    db.close();
    const before = snapshot(directory);
    const exit = await Effect.runPromiseExit(
      withUpgradeInspection(filename, (inspection) => {
        ({ captured } = inspection);
        return Effect.fail("caller failed");
      }).pipe(Effect.provide(ownershipLayer(`${filename}.owner`)))
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(snapshot(directory)).toEqual(before);
    expect(captured).not.toBe("");
    expect(existsSync(path.dirname(path.dirname(captured)))).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

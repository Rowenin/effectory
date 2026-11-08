/* oxlint-disable unicorn/no-await-expression-member -- Assertions inspect fixture results. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, mkdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Artifact } from "@offtree/effectory-sdk";
import { Effect, Stream } from "effect";

import { repositorySnapshot } from "../src/backup.ts";
import { createStore } from "../src/host-store.ts";
import { stagingDirectory } from "../src/lake-binary.ts";
import { createLake } from "../src/lake.ts";
import { storageError } from "../src/storage-error.ts";

const Data = Artifact.make({
  contentType: "application/octet-stream",
  id: "recovery/file",
  kind: "bytes",
  version: 1,
});
const payload = new Uint8Array([0, 254, 255, 9]);
const digest = createHash("sha256").update(payload).digest("hex");
async function fixture<A>(
  body: (f: {
    db: Database;
    lake: ReturnType<typeof createLake>;
    blobs: string;
    root: string;
    store: ReturnType<typeof createStore>;
  }) => Promise<A>
) {
  const root = await mkdtemp(path.join(tmpdir(), "effectory-binary-recovery-"));
  const db = new Database(path.join(root, "state.sqlite"));
  const lease = { assertActive: () => {}, token: "test-recovery" };
  const store = createStore(db, lease);
  const blobs = path.join(root, "blobs");
  const lake = createLake(db, blobs, lease);
  try {
    return await body({ blobs, db, lake, root, store });
  } finally {
    db.close();
    await rm(root, { force: true, recursive: true });
  }
}

for (const phase of [
  "stage-only",
  "intent-before-link",
  "link-before-commit",
  "unlink-before-resolve",
  "resolve-before-staging-unlink",
] as const) {
  test(`binary installation recovery is repeatable after ${phase}`, () =>
    fixture(async ({ db, lake, blobs }) => {
      const stage = `${crypto.randomUUID()}.stage`;
      const staged = path.join(stagingDirectory(blobs), stage);
      writeFileSync(staged, payload);
      if (phase !== "stage-only" && phase !== "resolve-before-staging-unlink") {
        db.query("INSERT INTO lake_binary_installs VALUES (?, ?, ?)").run(
          stage,
          digest,
          payload.length
        );
      }
      if (phase === "link-before-commit") {
        linkSync(staged, path.join(blobs, digest));
      }
      await Effect.runPromise(lake.recoverBinary);
      await Effect.runPromise(lake.recoverBinary);
      expect(readdirSync(stagingDirectory(blobs))).toEqual([]);
      expect(db.query("SELECT * FROM lake_binary_installs").all()).toEqual([]);
      expect(existsSync(path.join(blobs, digest))).toBe(false);
    }));
}

test("recovery preserves unproven copied blobs and does not trust a recorded digest alone", () =>
  fixture(async ({ db, lake, blobs }) => {
    const stage = `${crypto.randomUUID()}.stage`;
    const staged = path.join(stagingDirectory(blobs), stage);
    writeFileSync(staged, payload);
    db.query("INSERT INTO lake_binary_installs VALUES (?, ?, ?)").run(
      stage,
      digest,
      payload.length
    );
    await copyFile(staged, path.join(blobs, digest));
    await Effect.runPromise(lake.recoverBinary);
    expect(readFileSync(path.join(blobs, digest))).toEqual(
      Buffer.from(payload)
    );
    expect(readdirSync(stagingDirectory(blobs))).toEqual([]);
  }));

test("failed intent resolution retains staging evidence and retry finishes after unlink", () =>
  fixture(async ({ db, lake, blobs }) => {
    const stage = `${crypto.randomUUID()}.stage`;
    const staged = path.join(stagingDirectory(blobs), stage);
    writeFileSync(staged, payload);
    linkSync(staged, path.join(blobs, digest));
    db.query("INSERT INTO lake_binary_installs VALUES (?, ?, ?)").run(
      stage,
      digest,
      payload.length
    );
    db.exec(
      "CREATE TRIGGER stop_resolve BEFORE DELETE ON lake_binary_installs BEGIN SELECT RAISE(ABORT,'stop intent resolve'); END"
    );
    const failure = await Effect.runPromise(
      lake.recoverBinary.pipe(Effect.flip)
    );
    expect(failure.code).toBe("Unavailable");
    expect(existsSync(staged)).toBe(true);
    expect(existsSync(path.join(blobs, digest))).toBe(false);
    db.exec("DROP TRIGGER stop_resolve");
    await Effect.runPromise(lake.recoverBinary);
    expect(existsSync(staged)).toBe(false);
  }));

test("recovery retains committed content and failed publication rolls back metadata and resolves intent", () =>
  fixture(async ({ db, lake, blobs, store }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const run = yield* store.submit(
          {
            input: {},
            kind: "task",
            requestKey: "recovery",
            targetId: "producer",
          },
          "revision",
          "owner"
        );
        yield* store.admitAttempt(run.runId, "task", 1, "idempotent");
        const identity = {
          attempt: 1,
          attemptId: "attempt",
          invocationPath: "task",
          revision: "revision",
          runId: run.runId,
          taskId: "producer",
          taskVersion: 1,
        };
        db.exec(
          "CREATE TRIGGER stop_metadata BEFORE INSERT ON lake_records BEGIN SELECT RAISE(ABORT,'stop commit'); END"
        );
        const failure = yield* lake
          .publishBytes(identity, "file", Data, Stream.succeed(payload), {
            key: "main",
          })
          .pipe(Effect.flip);
        expect(failure.code).toBe("Unavailable");
        expect(db.query("SELECT * FROM lake_binary_installs").all()).toEqual(
          []
        );
        expect(existsSync(path.join(blobs, digest))).toBe(false);
        db.exec("DROP TRIGGER stop_metadata");
        const reference = yield* lake.publishBytes(
          identity,
          "file",
          Data,
          Stream.succeed(payload),
          { key: "main" }
        );
        const stage = `${crypto.randomUUID()}.stage`;
        linkSync(
          path.join(blobs, digest),
          path.join(stagingDirectory(blobs), stage)
        );
        db.query("INSERT INTO lake_binary_installs VALUES (?, ?, ?)").run(
          stage,
          digest,
          payload.length
        );
        yield* lake.recoverBinary;
        expect(existsSync(path.join(blobs, digest))).toBe(true);
        expect(readdirSync(stagingDirectory(blobs))).toEqual([]);
        expect(
          yield* lake.publishBytes(
            identity,
            "file",
            Data,
            Stream.succeed(payload),
            { key: "main" }
          )
        ).toEqual(reference);
      })
    );
  }));

test("binary recovery rejects unexpected files and missing intent evidence", () =>
  fixture(async ({ db, lake, blobs }) => {
    db.query("INSERT INTO lake_binary_installs VALUES (?, ?, ?)").run(
      `${crypto.randomUUID()}.stage`,
      digest,
      payload.length
    );
    expect(
      (await Effect.runPromise(lake.recoverBinary.pipe(Effect.flip))).code
    ).toBe("Unavailable");
    db.exec("DELETE FROM lake_binary_installs");
    writeFileSync(path.join(stagingDirectory(blobs), "foreign-file"), "keep");
    expect(
      (await Effect.runPromise(lake.recoverBinary.pipe(Effect.flip))).code
    ).toBe("Unavailable");
    expect(
      readFileSync(path.join(stagingDirectory(blobs), "foreign-file"), "utf-8")
    ).toBe("keep");
  }));

test("backup refuses staging before opening the source database, with unchanged WAL and SHM", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "effectory-binary-backup-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "copy");
  const directory = path.join(source, ".effectory");
  await mkdir(path.join(directory, "blobs", ".binary-staging"), {
    recursive: true,
  });
  writeFileSync(path.join(source, "effectory.ts"), "// fixture");
  writeFileSync(
    path.join(directory, "state.sqlite"),
    "not a database: must never be opened"
  );
  writeFileSync(path.join(directory, "state.sqlite-wal"), "unchanged WAL");
  writeFileSync(
    path.join(directory, "blobs", ".binary-staging", "unfinished.stage"),
    "pending"
  );
  try {
    const failure = await Effect.runPromise(
      repositorySnapshot(source, destination, false).pipe(Effect.flip)
    );
    expect(failure.code).toBe("Conflict");
    expect(failure.message).toContain("daemon start");
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(path.join(directory, "state.sqlite-shm"))).toBe(false);
    expect(
      readFileSync(path.join(directory, "state.sqlite-wal"), "utf-8")
    ).toBe("unchanged WAL");
    expect(
      readFileSync(path.join(directory, "state.sqlite"), "utf-8")
    ).toContain("not a database");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("nested Effect filesystem errno maps to StorageFull without losing operation errors", () => {
  expect(
    storageError({ reason: { cause: { code: "ENOSPC" } } }, "IO").code
  ).toBe("StorageFull");
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  expect(storageError(cycle, "IO").code).toBe("Unavailable");
});

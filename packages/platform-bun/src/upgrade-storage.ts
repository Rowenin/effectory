import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect } from "effect";

import { RepositoryLease } from "./ownership.ts";
import type { Lease } from "./ownership.ts";
import { storageError } from "./storage-error.ts";
import { validateUpgradeWal } from "./upgrade-wal.ts";

const maximumBytes = 34_359_738_368;
const suffixes = ["", "-wal", "-shm", "-journal"] as const;
export interface InspectionFile {
  readonly bytes: number;
  readonly digest: string;
  readonly suffix: (typeof suffixes)[number];
}
const io = <A>(operation: () => A) =>
  Effect.try({
    catch: (cause) =>
      storageError(cause, "Upgrade inspection storage is unavailable"),
    try: operation,
  });
const changed = () =>
  new OperationError({
    code: "Conflict",
    message: "Database or sidecars changed during offline upgrade inspection",
  });
const open = (filename: string, writing: boolean) =>
  Effect.acquireRelease(
    io(() => openSync(filename, writing ? "wx" : "r", 0o600)),
    (fd) => Effect.sync(() => closeSync(fd))
  );

function inventory(filename: string) {
  if (lstatSync(path.dirname(filename)).isSymbolicLink()) {
    throw new OperationError({
      code: "InvalidInput",
      message: "Upgrade inspection requires a real database directory",
    });
  }
  let total = 0;
  const present = suffixes.filter((suffix) => {
    const target = filename + suffix;
    if (!existsSync(target)) {
      // A dangling symlink is not an absent sidecar.
      try {
        lstatSync(target);
      } catch (error) {
        if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") {
          return false;
        }
        throw error;
      }
      throw changed();
    }
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new OperationError({
        code: "InvalidInput",
        message:
          "Upgrade inspection requires single-link regular database files",
      });
    }
    total += stat.size;
    if (total > maximumBytes) {
      throw new OperationError({
        code: "LimitExceeded",
        message: "Database and sidecars exceed the 32 GiB inspection limit",
      });
    }
    return true;
  });
  if (!present.includes("")) {
    throw new OperationError({
      code: "NotFound",
      message: "Upgrade database is missing",
    });
  }
  return present;
}

/** Copy/hash in bounded chunks; ownership is checked before every chunk. */
function capture(
  source: string,
  destination: string | undefined,
  lease: Lease
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const input = yield* open(source, false);
      const output =
        destination === undefined ? undefined : yield* open(destination, true);
      const initial = yield* io(() => fstatSync(input));
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(1_048_576);
      let bytes = 0;
      const readChunk = () => {
        lease.assertActive();
        const size = readSync(input, buffer);
        bytes += size;
        if (bytes > maximumBytes || bytes > initial.size) {
          throw changed();
        }
        hash.update(buffer.subarray(0, size));
        if (output !== undefined) {
          let offset = 0;
          while (offset < size) {
            const written = writeSync(output, buffer, offset, size - offset);
            if (written === 0) {
              throw new Error("Inspection copy made no progress");
            }
            offset += written;
          }
        }
        return size;
      };
      for (;;) {
        const count = yield* io(readChunk);
        if (count === 0) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* io(() => {
        const final = lstatSync(source);
        if (
          bytes !== initial.size ||
          final.ino !== initial.ino ||
          final.dev !== initial.dev ||
          final.size !== initial.size ||
          final.mtimeMs !== initial.mtimeMs
        ) {
          throw changed();
        }
      });
      return { bytes, digest: hash.digest("hex") };
    })
  );
}

export interface UpgradeInspection {
  readonly database: Database;
  /** Scope-owned private checkpointed copy, for read-only storage adapters. */
  readonly filename: string;
  /** Untouched captured bytes. Temporary evidence, not a durable rollback copy. */
  readonly captured: string;
  readonly files: readonly InspectionFile[];
}

/**
 * Requires offline repository ownership. Never opens source databases with
 * SQLite: even readonly opens can create SHM or silently omit a damaged WAL.
 * Recovery and queries use a second private copy. Both copies are scope-owned.
 */
function withInspection<A, E, R>(
  filename: string,
  use: (inspection: UpgradeInspection) => Effect.Effect<A, E, R>,
  certifyWal: boolean
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* RepositoryLease;
      yield* io(() => lease.assertActive());
      const present = yield* io(() => inventory(filename));
      const temporary = yield* Effect.acquireRelease(
        io(() =>
          mkdtempSync(path.join(tmpdir(), "effectory-upgrade-inspection-"))
        ),
        (directory) =>
          Effect.promise(() => rm(directory, { force: true, recursive: true }))
      );
      const captured = path.join(temporary, "captured", "database.sqlite");
      const recovered = path.join(temporary, "inspection", "database.sqlite");
      yield* io(() => {
        mkdirSync(path.dirname(captured), { mode: 0o700 });
        mkdirSync(path.dirname(recovered), { mode: 0o700 });
      });
      const files: InspectionFile[] = [];
      for (const suffix of present) {
        files.push({
          ...(yield* capture(filename + suffix, captured + suffix, lease)),
          suffix,
        });
      }
      yield* io(() => {
        if (JSON.stringify(inventory(filename)) !== JSON.stringify(present)) {
          throw changed();
        }
      });
      for (const file of files) {
        const current = yield* capture(
          filename + file.suffix,
          undefined,
          lease
        );
        if (current.bytes !== file.bytes || current.digest !== file.digest) {
          return yield* changed();
        }
      }
      const journal = files.find((file) => file.suffix === "-journal");
      if (journal && journal.bytes > 0) {
        return yield* new OperationError({
          code: "RevisionUnavailable",
          message:
            "Upgrade inspection requires compatible recovery of the rollback journal before transition",
        });
      }
      const wal =
        certifyWal && present.includes("-wal")
          ? yield* validateUpgradeWal(`${captured}-wal`, maximumBytes)
          : null;
      for (const file of files) {
        // Rebuild SHM privately rather than trusting machine-local bookkeeping.
        if (file.suffix === "-shm") {
          continue;
        }
        const copied = yield* capture(
          captured + file.suffix,
          recovered + file.suffix,
          lease
        );
        if (copied.bytes !== file.bytes || copied.digest !== file.digest) {
          return yield* changed();
        }
      }
      yield* io(() => {
        const db = new Database(recovered, { strict: true });
        try {
          if (wal && wal.frames > 0) {
            const pageSize = db
              .query<{ page_size: number }, []>("PRAGMA page_size")
              .get()?.page_size;
            const pages = db
              .query<{ page_count: number }, []>("PRAGMA page_count")
              .get()?.page_count;
            if (pageSize !== wal.pageSize || pages !== wal.lastCommitPages) {
              throw new OperationError({
                code: "RevisionUnavailable",
                message:
                  "Private SQLite recovery disagrees with the validated WAL commit",
              });
            }
          }
          const check = db
            .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
            .all();
          if (check.length !== 1 || check[0]?.integrity_check !== "ok") {
            throw new OperationError({
              code: "RevisionUnavailable",
              message:
                "Upgrade inspection database integrity validation failed",
            });
          }
          const result = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
          if (result && Reflect.get(result, "busy") !== 0) {
            throw new OperationError({
              code: "Unavailable",
              message: "Private upgrade checkpoint could not finish",
            });
          }
        } finally {
          db.close();
        }
      });
      const database = yield* Effect.acquireRelease(
        io(() => new Database(recovered, { readonly: true, strict: true })),
        (db) => Effect.sync(() => db.close())
      );
      return yield* use({ captured, database, filename: recovered, files });
    })
  );
}

/** Transition admission: ambiguous WAL tails must be recovered by a compatible host first. */
export function withUpgradeInspection<A, E, R>(
  filename: string,
  use: (inspection: UpgradeInspection) => Effect.Effect<A, E, R>
) {
  return withInspection(filename, use, true);
}

/**
 * Same-build startup only: SQLite owns ordinary crash recovery, including stale
 * tails left by WAL reuse. This view can validate work formats but CANNOT certify
 * complete acknowledged history or authorize a transition. Source stays untouched.
 */
export function withRuntimeInspection<A, E, R>(
  filename: string,
  use: (inspection: UpgradeInspection) => Effect.Effect<A, E, R>
) {
  return withInspection(filename, use, false);
}

/* oxlint-disable no-loop-func, no-bitwise -- Sequential Effect loops and native POSIX open flags. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  read,
  readdirSync,
  unlinkSync,
  write,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { OperationError } from "@effectory/runtime/protocol";
import { TaskRuntimeError } from "@offtree/effectory-sdk";
import { Effect, Schema, Semaphore, Stream } from "effect";

import type { Lease } from "./ownership.ts";
import { storageError } from "./storage-error.ts";

export const binaryLimit = 16_777_216;
export const blockBytes = 65_536;
export const stagingDirectory = (directory: string) =>
  path.join(directory, ".binary-staging");
const StageName = /^[a-f0-9-]{36}\.stage$/u;
const Digest = /^[a-f0-9]{64}$/u;
const Intent = Schema.Struct({
  bytes: Schema.Int,
  digest: Schema.String,
  stage: Schema.String,
});
const fail = (code: OperationError["code"], message: string) =>
  new OperationError({ code, message });
export const fileEffect = <A>(body: () => A) =>
  Effect.try({
    catch: (cause) =>
      storageError(cause, "Binary artifact storage operation failed"),
    try: body,
  });
// Await native IO completion before interruption can close/reuse its descriptor.
const io = <A>(body: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => storageError(cause, "Binary artifact IO failed"),
    try: body,
  }).pipe(Effect.uninterruptible);
const readAsync = promisify(read);
const writeAsync = promisify(write);
const syncAsync = promisify(fsync);
export const readBlock = (fd: number, buffer: Uint8Array, position: number) =>
  io(async () => {
    const result = await readAsync(fd, buffer, 0, buffer.byteLength, position);
    return result.bytesRead;
  });
const writeBlock = (fd: number, buffer: Uint8Array, position: number) =>
  io(async () => {
    const result = await writeAsync(fd, buffer, 0, buffer.byteLength, position);
    return result.bytesWritten;
  });
const syncFile = (fd: number) => io(() => syncAsync(fd));
export function syncDirectory(directory: string) {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
const statOptional = (filename: string) => {
  try {
    return lstatSync(filename);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      Reflect.get(error, "code") === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
};
function regularDirectory(directory: string) {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  if (!lstatSync(directory).isDirectory()) {
    throw fail(
      "Unavailable",
      "Binary staging must be a regular directory, not a symlink"
    );
  }
}
export function initializeBinaryStorage(database: Database, directory: string) {
  regularDirectory(stagingDirectory(directory));
  const columns = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ name: Schema.String }))
  )(database.query("PRAGMA table_info(lake_schemas)").all());
  database.transaction(() => {
    if (!columns.some((column) => column.name === "kind")) {
      database.exec(
        "ALTER TABLE lake_schemas ADD COLUMN kind TEXT NOT NULL DEFAULT 'json'"
      );
    }
    if (!columns.some((column) => column.name === "contentType")) {
      database.exec(
        "ALTER TABLE lake_schemas ADD COLUMN contentType TEXT NOT NULL DEFAULT 'application/json'"
      );
    }
    database.exec(
      "CREATE TABLE IF NOT EXISTS lake_binary_installs(stage TEXT PRIMARY KEY, digest TEXT NOT NULL, bytes INTEGER NOT NULL)"
    );
  })();
}

/** Resolves one intent before removing its evidence. Runs without yielding. */
function cleanup(database: Database, directory: string, stage: string) {
  if (!StageName.test(stage)) {
    throw fail("Unavailable", "Unsafe binary staging entry");
  }
  const staged = path.join(stagingDirectory(directory), stage);
  const raw = database
    .query(
      "SELECT stage,digest,bytes FROM lake_binary_installs WHERE stage = ?"
    )
    .get(stage);
  const stagingStat = statOptional(staged);
  if (stagingStat && !stagingStat.isFile()) {
    throw fail("Unavailable", "Binary staging contains a non-regular file");
  }
  if (raw) {
    const intent = Schema.decodeUnknownSync(Intent)(raw);
    if (!Digest.test(intent.digest) || !stagingStat) {
      throw fail(
        "Unavailable",
        "Binary installation intent is missing valid staging evidence"
      );
    }
    const destination = path.join(directory, intent.digest);
    const installed = statOptional(destination);
    const retained = database
      .query(
        "SELECT 1 FROM lake_records WHERE reclaimedAt IS NULL AND json_extract(metadataJson,'$.digest') = ? LIMIT 1"
      )
      .get(intent.digest);
    // Only current hard-link identity proves ownership; persisted inode numbers do not.
    if (
      !retained &&
      installed?.isFile() &&
      installed.dev === stagingStat.dev &&
      installed.ino === stagingStat.ino &&
      installed.nlink >= 2 &&
      stagingStat.nlink >= 2
    ) {
      unlinkSync(destination);
      syncDirectory(directory);
    }
    database
      .query("DELETE FROM lake_binary_installs WHERE stage = ?")
      .run(stage);
  }
  if (stagingStat) {
    unlinkSync(staged);
    syncDirectory(stagingDirectory(directory));
  }
}

function verify(fd: number, digest: string, expected: number) {
  return Effect.gen(function* () {
    const stat = yield* fileEffect(() => fstatSync(fd));
    if (!stat.isFile() || stat.size !== expected) {
      return yield* fail(
        "ContentUnavailable",
        "Existing artifact content has an invalid file type or length"
      );
    }
    const hash = createHash("sha256");
    const buffer = new Uint8Array(blockBytes);
    let position = 0;
    for (;;) {
      const size = yield* readBlock(fd, buffer, position);
      if (size === 0) {
        break;
      }
      position += size;
      if (position > expected) {
        return yield* fail(
          "ContentUnavailable",
          "Existing artifact length changed"
        );
      }
      hash.update(buffer.subarray(0, size));
    }
    if (position !== expected || hash.digest("hex") !== digest) {
      return yield* fail(
        "ContentUnavailable",
        "Existing artifact digest does not match"
      );
    }
  });
}
function taskFailure(failure: OperationError) {
  let code: string = failure.code;
  if (code === "Conflict") {
    code = "PublicationConflict";
  }
  if (code === "InvalidInput") {
    code = "InvalidBoundary";
  }
  return new TaskRuntimeError({ code, message: failure.message });
}

export function createBinaryStorage(
  database: Database,
  directory: string,
  lease: Lease
) {
  const permits = Semaphore.makeUnsafe(4);
  const recover = Effect.gen(function* () {
    // Iterate bounded batches; startup has exclusive ownership, no publications yet.
    for (;;) {
      const entries = yield* fileEffect(() => {
        lease.assertActive();
        return readdirSync(stagingDirectory(directory)).slice(0, 64);
      });
      if (entries.length === 0) {
        break;
      }
      yield* fileEffect(() => {
        for (const stage of entries) {
          lease.assertActive();
          cleanup(database, directory, stage);
        }
      });
      yield* Effect.yieldNow;
    }
    yield* fileEffect(() => {
      if (database.query("SELECT 1 FROM lake_binary_installs LIMIT 1").get()) {
        throw fail(
          "Unavailable",
          "Binary installation intent has no staging file"
        );
      }
    });
  });

  const publish = <A, E, R>(
    source: Stream.Stream<Uint8Array, E, R>,
    commit: (digest: string, bytes: number, resolve: () => void) => A
  ): Effect.Effect<A, E | TaskRuntimeError, R> =>
    permits.withPermits(1)(
      Effect.scoped(
        Effect.gen(function* () {
          const staging = yield* Effect.acquireRelease(
            fileEffect(() => {
              lease.assertActive();
              const stage = `${crypto.randomUUID()}.stage`;
              const filename = path.join(stagingDirectory(directory), stage);
              const fd = openSync(
                filename,
                constants.O_CREAT |
                  constants.O_EXCL |
                  constants.O_WRONLY |
                  constants.O_NOFOLLOW,
                0o600
              );
              return { fd, filename, stage };
            }).pipe(Effect.mapError(taskFailure)),
            ({ fd, stage }) =>
              fileEffect(() => {
                closeSync(fd);
                lease.assertActive();
                cleanup(database, directory, stage);
              }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(
                    `Binary installation cleanup pending: ${error.message}`
                  )
                )
              )
          );
          const hash = createHash("sha256");
          const buffer = new Uint8Array(blockBytes);
          let size = 0;
          yield* source.pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                if (!(chunk instanceof Uint8Array)) {
                  return yield* new TaskRuntimeError({
                    code: "InvalidBoundary",
                    message: "Binary sources must emit Uint8Array chunks",
                  });
                }
                if (size + chunk.byteLength > binaryLimit) {
                  return yield* new TaskRuntimeError({
                    code: "LimitExceeded",
                    message: "Binary artifact exceeds 16 MiB",
                  });
                }
                for (
                  let offset = 0;
                  offset < chunk.byteLength;
                  offset += blockBytes
                ) {
                  const length = Math.min(
                    blockBytes,
                    chunk.byteLength - offset
                  );
                  buffer.set(chunk.subarray(offset, offset + length), 0);
                  const owned = buffer.subarray(0, length);
                  hash.update(owned);
                  let written = 0;
                  while (written < length) {
                    const count = yield* writeBlock(
                      staging.fd,
                      owned.subarray(written),
                      size + written
                    ).pipe(Effect.mapError(taskFailure));
                    if (count === 0) {
                      return yield* new TaskRuntimeError({
                        code: "Unavailable",
                        message: "Binary artifact writer made no progress",
                      });
                    }
                    written += count;
                  }
                  size += length;
                }
              })
            )
          );
          yield* syncFile(staging.fd).pipe(Effect.mapError(taskFailure));
          const digest = hash.digest("hex");
          const destination = path.join(directory, digest);
          yield* fileEffect(() => {
            lease.assertActive();
            syncDirectory(stagingDirectory(directory));
            database
              .query(
                "INSERT INTO lake_binary_installs(stage,digest,bytes) VALUES (?, ?, ?)"
              )
              .run(staging.stage, digest, size);
          }).pipe(Effect.mapError(taskFailure));
          for (let retry = 0; retry < 8; retry += 1) {
            const outcome = yield* Effect.scoped(
              Effect.gen(function* () {
                const existing = yield* Effect.acquireRelease(
                  fileEffect(() => {
                    lease.assertActive();
                    if (!statOptional(destination)) {
                      return;
                    }
                    return openSync(
                      destination,
                      constants.O_RDONLY | constants.O_NOFOLLOW
                    );
                  }),
                  (fd) =>
                    fileEffect(() => {
                      if (fd !== undefined) {
                        closeSync(fd);
                      }
                    }).pipe(Effect.orDie)
                );
                if (existing !== undefined) {
                  yield* verify(existing, digest, size);
                }
                return yield* fileEffect(() => {
                  lease.assertActive();
                  const current = statOptional(destination);
                  if (current) {
                    if (existing === undefined) {
                      return { retry: true } as const;
                    }
                    const held = fstatSync(existing);
                    if (
                      !current.isFile() ||
                      current.dev !== held.dev ||
                      current.ino !== held.ino
                    ) {
                      return { retry: true } as const;
                    }
                  } else {
                    try {
                      linkSync(staging.filename, destination);
                    } catch (error) {
                      if (
                        typeof error === "object" &&
                        error !== null &&
                        Reflect.get(error, "code") === "EEXIST"
                      ) {
                        return { retry: true } as const;
                      }
                      throw storageError(
                        error,
                        "Binary artifacts require a repository filesystem supporting hard links"
                      );
                    }
                    syncDirectory(directory);
                  }
                  // No yield between pathname check/link and metadata transaction. Keep fd open.
                  const value = commit(digest, size, () => {
                    database
                      .query("DELETE FROM lake_binary_installs WHERE stage = ?")
                      .run(staging.stage);
                  });
                  return { retry: false, value } as const;
                });
              })
            ).pipe(Effect.mapError(taskFailure));
            if (!outcome.retry) {
              return outcome.value;
            }
          }
          return yield* new TaskRuntimeError({
            code: "Unavailable",
            message:
              "Binary artifact changed repeatedly during verification; retry publication",
          });
        })
      )
    );
  return { publish, recover };
}

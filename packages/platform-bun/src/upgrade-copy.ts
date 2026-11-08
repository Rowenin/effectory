/* oxlint-disable no-bitwise -- File-open flags and Unix permissions are bit masks. */
/* oxlint-disable no-loop-func -- Each scoped directory traversal completes before the next directory. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  opendirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Layer, Schema } from "effect";

import { ownershipLayer, RepositoryLease } from "./ownership.ts";
import { snapshotMarker } from "./snapshot-marker.ts";
import { storageError } from "./storage-error.ts";

const maximumBytes = 137_438_953_472;
const maximumFileBytes = 34_359_738_368;
const maximumEntries = 50_000;
const maximumManifestBytes = 16_777_216;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Relative = Schema.String.check(Schema.isMaxLength(4096));
const Directory = Schema.Struct({
  kind: Schema.Literal("Directory"),
  path: Relative,
});
const File = Schema.Struct({
  bytes: Schema.Int.check(
    Schema.isBetween({ maximum: maximumFileBytes, minimum: 0 })
  ),
  digest: Digest,
  executable: Schema.Boolean,
  kind: Schema.Literal("File"),
  path: Relative,
});
const Manifest = Schema.Struct({
  createdAt: Schema.String,
  entries: Schema.Array(Schema.Union([Directory, File])).check(
    Schema.isMaxLength(maximumEntries)
  ),
  format: Schema.Literal(1),
  planId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u)),
  source: Schema.String.check(Schema.isMaxLength(4096)),
});
export type UpgradeInventoryEntry = (typeof Manifest.Type)["entries"][number];
type Entry = UpgradeInventoryEntry;
const conflict = (message: string) =>
  new OperationError({ code: "Conflict", message });
const invalid = (message: string) =>
  new OperationError({ code: "InvalidInput", message });
const limited = (message: string) =>
  new OperationError({ code: "LimitExceeded", message });
const io = <A>(action: () => A) =>
  Effect.try({
    catch: (cause) =>
      storageError(cause, "Runtime upgrade recovery copy is unavailable"),
    try: action,
  });
const flush = (filename: string) => {
  const fd = openSync(filename, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
const excluded = (relative: string) => {
  const parts = relative.split("/");
  return (
    parts.includes("node_modules") ||
    parts.includes(".git") ||
    relative === "effectory.snapshot.json" ||
    relative === snapshotMarker ||
    relative === ".effectory/upgrades" ||
    relative.startsWith(".effectory/upgrades/") ||
    relative.startsWith(".effectory/state.sqlite.owner") ||
    [
      ".effectory/daemon.json",
      ".effectory/daemon.json.tmp",
      ".effectory/daemon.log",
      ".effectory/state.sqlite-shm",
      ".effectory/vaults.sqlite-shm",
    ].includes(relative)
  );
};
function valid(relative: string) {
  return (
    relative.length > 0 &&
    relative.length <= 4096 &&
    !path.isAbsolute(relative) &&
    !relative.includes("\\") &&
    relative
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..") &&
    !excluded(relative)
  );
}
function contained(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/** Chunked copies/hashes yield between reads and check offline ownership. */
function content(filename: string, destination?: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* RepositoryLease;
      const input = yield* Effect.acquireRelease(
        io(() => openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW)),
        (fd) => Effect.sync(() => closeSync(fd))
      );
      const initial = yield* io(() => fstatSync(input));
      if (!initial.isFile() || initial.size > maximumFileBytes) {
        return yield* limited(
          "Recovery copies require regular files of at most 32 GiB"
        );
      }
      const executable = (initial.mode & 0o100) !== 0;
      const output =
        destination === undefined
          ? undefined
          : yield* Effect.acquireRelease(
              io(() => openSync(destination, "wx", 0o600)),
              (fd) => Effect.sync(() => closeSync(fd))
            );
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(1_048_576);
      let bytes = 0;
      for (;;) {
        const count = yield* io(() => {
          lease.assertActive();
          const size = readSync(input, buffer);
          bytes += size;
          if (bytes > initial.size || bytes > maximumFileBytes) {
            throw conflict("Recovery-copy source changed while being captured");
          }
          hash.update(buffer.subarray(0, size));
          if (output !== undefined) {
            let offset = 0;
            while (offset < size) {
              const written = writeSync(output, buffer, offset, size - offset);
              if (written === 0) {
                throw new Error("Recovery copy made no progress");
              }
              offset += written;
            }
          }
          return size;
        });
        if (count === 0) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* io(() => {
        const final = lstatSync(filename);
        if (
          !final.isFile() ||
          final.ino !== initial.ino ||
          final.dev !== initial.dev ||
          final.size !== bytes ||
          bytes !== initial.size ||
          final.mtimeMs !== initial.mtimeMs ||
          final.mode !== initial.mode
        ) {
          throw conflict("Recovery-copy source changed while being captured");
        }
        if (output !== undefined) {
          fchmodSync(output, executable ? 0o700 : 0o600);
          fsyncSync(output);
        }
      });
      return { bytes, digest: hash.digest("hex"), executable };
    })
  );
}

export function inventoryUpgradeRepository(root: string) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const pending = [""];
    const entries: Entry[] = [];
    let bytes = 0;
    let metadataBytes = 0;
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) {
        break;
      }
      yield* Effect.gen(function* () {
        const handle = yield* Effect.acquireRelease(
          io(() => {
            lease.assertActive();
            const location = path.join(root, directory);
            if (!lstatSync(location).isDirectory()) {
              throw invalid("Recovery copies require real directories");
            }
            return opendirSync(location, { bufferSize: 64 });
          }),
          (directoryHandle) => Effect.sync(() => directoryHandle.closeSync())
        );
        for (;;) {
          const child = yield* io(() => handle.readSync());
          if (child === null) {
            break;
          }
          const relative =
            directory === "" ? child.name : `${directory}/${child.name}`;
          if (excluded(relative)) {
            continue;
          }
          if (
            !valid(relative) ||
            child.isSymbolicLink() ||
            (!child.isFile() && !child.isDirectory())
          ) {
            return yield* invalid(
              "Recovery copies require regular files and directories without symlinks"
            );
          }
          if (entries.length >= maximumEntries) {
            return yield* limited("Recovery copy exceeds 50000 entries");
          }
          if (child.isDirectory()) {
            entries.push({ kind: "Directory", path: relative });
            pending.push(relative);
          } else {
            const value = yield* content(path.join(root, relative));
            bytes += value.bytes;
            if (bytes > maximumBytes) {
              return yield* limited("Recovery copy exceeds 128 GiB");
            }
            entries.push({ ...value, kind: "File", path: relative });
          }
          metadataBytes += Buffer.byteLength(JSON.stringify(entries.at(-1)));
          if (metadataBytes > maximumManifestBytes - 16_384) {
            return yield* limited(
              "Recovery-copy inventory exceeds its 16 MiB metadata budget"
            );
          }
          yield* Effect.yieldNow;
        }
      }).pipe(Effect.scoped);
    }
    return entries.toSorted((a, b) =>
      a.path < b.path ? -1 : Number(a.path > b.path)
    );
  });
}
function equal(expected: readonly Entry[], actual: readonly Entry[]) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw conflict(
      "Recovery-copy contents changed or do not match the captured source"
    );
  }
}
const markerPath = (destination: string) =>
  path.join(destination, "repository", snapshotMarker);

/** Keep the image offline through the caller's Scope, including migration. */
function pinCopy(destination: string) {
  return Effect.gen(function* () {
    // Ownership files are deliberately excluded from the content manifest. Do
    // not let that exclusion turn SQLite acquisition into a write through a
    // substituted directory, symlink or hard link outside the recovery image.
    const filename = yield* io(() => {
      const state = path.join(destination, "repository", ".effectory");
      if (!lstatSync(state).isDirectory()) {
        throw invalid("Recovery-copy state directory must be a real directory");
      }
      const owner = path.join(state, "state.sqlite.owner");
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try {
          const stat = lstatSync(owner + suffix);
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576) {
            throw invalid(
              "Recovery-copy ownership files must be single-link regular files of at most 1 MiB"
            );
          }
        } catch (error) {
          if (
            typeof error !== "object" ||
            error === null ||
            Reflect.get(error, "code") !== "ENOENT"
          ) {
            throw error;
          }
        }
      }
      return owner;
    });
    const scope = yield* Effect.scope;
    yield* Layer.buildWithScope(ownershipLayer(filename), scope).pipe(
      Effect.mapError(() =>
        conflict(
          "Recovery copy is owned by another process or its ownership file is unavailable"
        )
      )
    );
  });
}
function durableFile(filename: string, bytes: string) {
  const fd = openSync(filename, "wx", 0o600);
  try {
    const buffer = Buffer.from(bytes);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const written = writeSync(fd, buffer, offset, buffer.byteLength - offset);
      if (written === 0) {
        throw new Error("Recovery manifest made no progress");
      }
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Creates a new external copy. Any failure leaves an incomplete copy, never a
 * purported rollback image. It is retained for explicit recovery/cleanup; this
 * function never overwrites or recursively deletes an existing destination.
 */
export function createUpgradeRecoveryCopy(
  repository: string,
  destination: string,
  planId: string,
  step: (stage: string) => Effect.Effect<void> = () => Effect.void
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const source = yield* io(() => {
      lease.assertActive();
      const root = realpathSync(repository);
      if (!path.isAbsolute(destination) || root.length > 4096) {
        throw invalid(
          "Recovery copies require an absolute destination and a supported source path"
        );
      }
      const parent = realpathSync(path.dirname(destination));
      if (contained(root, path.join(parent, path.basename(destination)))) {
        throw invalid(
          "Upgrade recovery copies must be outside the source repository"
        );
      }
      try {
        lstatSync(path.join(root, snapshotMarker));
        throw conflict(
          "Cannot upgrade or copy an incomplete repository snapshot"
        );
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          Reflect.get(error, "code") !== "ENOENT"
        ) {
          throw error;
        }
      }
      Schema.decodeUnknownSync(Manifest.fields.planId)(planId);
      return root;
    });
    const entries = yield* inventoryUpgradeRepository(source);
    if (
      !entries.some(
        (entry) =>
          entry.path === ".effectory/state.sqlite" && entry.kind === "File"
      )
    ) {
      return yield* invalid(
        "Recovery copy requires an initialized runtime database"
      );
    }
    yield* io(() => {
      lease.assertActive();
      mkdirSync(destination, { mode: 0o700 });
      mkdirSync(path.join(destination, "repository"), { mode: 0o700 });
      mkdirSync(path.join(destination, "repository", ".effectory"), {
        mode: 0o700,
      });
      durableFile(
        markerPath(destination),
        "Runtime upgrade recovery copy is incomplete\n"
      );
      flush(path.join(destination, "repository"));
      flush(destination);
      flush(path.dirname(destination));
    });
    yield* pinCopy(destination);
    yield* step("created");
    for (const entry of entries) {
      const output = path.join(destination, "repository", entry.path);
      if (entry.kind === "Directory") {
        if (entry.path !== ".effectory") {
          yield* io(() => mkdirSync(output, { mode: 0o700 }));
        }
      } else {
        const copied = yield* content(path.join(source, entry.path), output);
        yield* io(() =>
          equal([entry], [{ ...copied, kind: "File", path: entry.path }])
        );
      }
      yield* step("copied-entry");
    }
    // Re-open and hash independently. Copying success is not verification.
    const copied = yield* inventoryUpgradeRepository(
      path.join(destination, "repository")
    );
    const stillCurrent = yield* inventoryUpgradeRepository(source);
    yield* io(() => {
      equal(entries, copied);
      equal(entries, stillCurrent);
    });
    yield* step("verified");
    const manifest = {
      createdAt: new Date().toISOString(),
      entries,
      format: 1 as const,
      planId,
      source,
    };
    const encoded = JSON.stringify(manifest);
    if (Buffer.byteLength(encoded) > maximumManifestBytes) {
      return yield* limited("Recovery-copy manifest exceeds 16 MiB");
    }
    // Persist children before their parents and completion metadata. A stop
    // during these flushes leaves the incomplete marker in place.
    for (const entry of entries.toReversed()) {
      if (entry.kind === "Directory") {
        yield* io(() => {
          lease.assertActive();
          flush(path.join(destination, "repository", entry.path));
        });
        yield* Effect.yieldNow;
      }
    }
    yield* io(() => {
      lease.assertActive();
      flush(path.join(destination, "repository"));
      durableFile(path.join(destination, "manifest.pending"), encoded);
      renameSync(
        path.join(destination, "manifest.pending"),
        path.join(destination, "manifest.json")
      );
      flush(destination);
    });
    yield* step("manifest-published");
    yield* io(() => {
      lease.assertActive();
      unlinkSync(markerPath(destination));
      flush(path.join(destination, "repository"));
      flush(destination);
    });
    return {
      destination,
      digest: createHash("sha256").update(encoded).digest("hex"),
      manifest,
    };
  });
}

/** Verifies and pins a complete image without executing code or opening runtime databases. */
export function verifyUpgradeRecoveryCopy(
  destination: string,
  planId: string,
  expectedDigest: string
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const manifest = yield* io(() => {
      lease.assertActive();
      if (
        !lstatSync(destination).isDirectory() ||
        !lstatSync(path.join(destination, "repository")).isDirectory()
      ) {
        throw invalid("Recovery copy must be a real directory");
      }
      try {
        lstatSync(markerPath(destination));
        throw conflict("Upgrade recovery copy is incomplete");
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          Reflect.get(error, "code") !== "ENOENT"
        ) {
          throw error;
        }
      }
      const filename = path.join(destination, "manifest.json");
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.size > maximumManifestBytes) {
        throw invalid("Invalid recovery-copy manifest");
      }
      const bytes = readFileSync(filename);
      if (createHash("sha256").update(bytes).digest("hex") !== expectedDigest) {
        throw conflict("Recovery-copy manifest digest changed");
      }
      const value = Schema.decodeUnknownSync(Manifest)(
        JSON.parse(bytes.toString("utf-8")),
        { onExcessProperty: "error" }
      );
      if (value.planId !== planId) {
        throw conflict("Recovery copy belongs to another upgrade plan");
      }
      let total = 0;
      const names = new Set<string>();
      for (const entry of value.entries) {
        if (!valid(entry.path) || names.has(entry.path)) {
          throw invalid("Unsafe or duplicate recovery-copy path");
        }
        names.add(entry.path);
        if (entry.kind === "File") {
          total += entry.bytes;
        }
      }
      if (total > maximumBytes) {
        throw limited("Recovery copy exceeds 128 GiB");
      }
      return value;
    });
    yield* pinCopy(destination);
    const actual = yield* inventoryUpgradeRepository(
      path.join(destination, "repository")
    );
    yield* io(() => equal(manifest.entries, actual));
    return manifest;
  });
}

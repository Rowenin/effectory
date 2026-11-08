/* oxlint-disable no-await-in-loop */
// Traverse and copy sequentially to bound memory and keep verification ordered.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { chmod, copyFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import {
  checkJsonBudget,
  canonical,
} from "@offtree/effectory-sdk/internal/boundary";
import { Effect, Schema } from "effect";

import { ownershipLayer, RepositoryLease } from "./ownership.ts";
import type { Lease } from "./ownership.ts";
import { retirementMarker } from "./run-reclamation.ts";
import { snapshotMarker } from "./snapshot-marker.ts";
import { storageError } from "./storage-error.ts";
import { assertUpgradeIdle } from "./upgrade-transition-gate.ts";

export { snapshotMarker } from "./snapshot-marker.ts";
const manifestName = "effectory.snapshot.json";
const maximumBytes = 1_073_741_824;
const maximumFileBytes = 134_217_728;
const maximumFiles = 50_000;
const File = Schema.Struct({
  bytes: Schema.Int.check(
    Schema.isBetween({ maximum: maximumFileBytes, minimum: 0 })
  ),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  executable: Schema.Boolean,
  path: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
});
const Manifest = Schema.Struct({
  createdAt: Schema.String,
  files: Schema.Array(File).check(Schema.isMaxLength(maximumFiles)),
  format: Schema.Literal(1),
});
const failure = (code: OperationError["code"], message: string) =>
  new OperationError({ code, message });
function excluded(relative: string) {
  const parts = relative.split("/");
  return (
    parts.includes("node_modules") ||
    parts.includes(".git") ||
    relative === manifestName ||
    relative === snapshotMarker ||
    [
      ".effectory/daemon.json",
      ".effectory/daemon.json.tmp",
      ".effectory/daemon.log",
    ].includes(relative) ||
    relative.startsWith(".effectory/state.sqlite.owner") ||
    relative === ".effectory/state.sqlite-shm" ||
    relative === ".effectory/vaults.sqlite-shm"
  );
}
function validPath(relative: string) {
  return (
    !path.isAbsolute(relative) &&
    !relative.includes("\\") &&
    relative
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..") &&
    !excluded(relative)
  );
}
function digestFile(filename: string) {
  const descriptor = openSync(filename, "r");
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumFileBytes) {
      throw failure(
        "LimitExceeded",
        "Snapshot file is not regular or exceeds 128 MiB"
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(524_288);
    let bytes = 0;
    for (;;) {
      const size = readSync(descriptor, buffer);
      if (size === 0) {
        break;
      }
      bytes += size;
      if (bytes > maximumFileBytes) {
        throw failure("LimitExceeded", "Snapshot file exceeds 128 MiB");
      }
      hash.update(buffer.subarray(0, size));
    }
    return { bytes, digest: hash.digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}
async function inventory(root: string): Promise<(typeof File.Type)[]> {
  const pending = [""];
  const files: (typeof File.Type)[] = [];
  let visited = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      break;
    }
    for (const entry of await readdir(path.join(root, directory), {
      withFileTypes: true,
    })) {
      const relative =
        directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (excluded(relative)) {
        continue;
      }
      visited += 1;
      if (visited > maximumFiles || relative.length > 4096) {
        throw failure(
          "LimitExceeded",
          "Snapshot exceeds 50000 entries or its path limit"
        );
      }
      if (!validPath(relative) || entry.isSymbolicLink()) {
        throw failure(
          "InvalidInput",
          "Snapshots require regular files and directories; source symlinks are unsupported"
        );
      }
      if (entry.isDirectory()) {
        pending.push(relative);
        continue;
      }
      if (!entry.isFile()) {
        throw failure("InvalidInput", "Snapshot contains a special file");
      }
      const filename = path.join(root, relative);
      const content = digestFile(filename);
      bytes += content.bytes;
      if (bytes > maximumBytes) {
        throw failure("LimitExceeded", "Snapshot exceeds 1 GiB");
      }
      // Preserve owner execution only; snapshots and restores are private.
      const executable = Math.floor(lstatSync(filename).mode / 64) % 2 === 1;
      files.push({ ...content, executable, path: relative });
    }
  }
  return files.toSorted((left, right) =>
    left.path < right.path ? -1 : Number(left.path > right.path)
  );
}
function readManifest(root: string) {
  const filename = path.join(root, manifestName);
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_777_216) {
    throw failure(
      "InvalidInput",
      "Snapshot manifest is invalid or exceeds 16 MiB"
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(filename, "utf-8"));
  checkJsonBudget(parsed, { bytes: 16_777_216, depth: 8, values: 500_000 });
  const manifest = Schema.decodeUnknownSync(Manifest)(parsed, {
    onExcessProperty: "error",
  });
  const names = new Set<string>();
  let bytes = 0;
  for (const item of manifest.files) {
    if (!validPath(item.path) || names.has(item.path)) {
      throw failure(
        "InvalidInput",
        "Snapshot manifest contains unsafe or duplicate paths"
      );
    }
    names.add(item.path);
    bytes += item.bytes;
  }
  if (bytes > maximumBytes) {
    throw failure("LimitExceeded", "Snapshot exceeds 1 GiB");
  }
  if (!names.has(".effectory/state.sqlite") || !names.has("effectory.ts")) {
    throw failure(
      "InvalidInput",
      "Snapshot is missing its database or application entrypoint"
    );
  }
  return manifest;
}
function verify(
  expected: readonly (typeof File.Type)[],
  actual: readonly (typeof File.Type)[]
) {
  if (canonical(expected) !== canonical(actual)) {
    throw failure(
      "Conflict",
      "Snapshot files changed or do not match their manifest"
    );
  }
}
function flush(filename: string) {
  const descriptor = openSync(filename, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
async function copySnapshot(
  source: string,
  destination: string,
  restoring: boolean,
  lease: Lease
) {
  lease.assertActive();
  assertUpgradeIdle(source);
  if (existsSync(path.join(source, snapshotMarker))) {
    throw failure(
      "Conflict",
      "Snapshot source contains an incomplete-copy marker"
    );
  }
  if (existsSync(path.join(source, ".effectory", retirementMarker))) {
    throw failure(
      "Conflict",
      "Unfinished run reclamation; resume run reclaim apply or start the daemon before backup"
    );
  }
  // Filesystem-only check: even opening SQLite read-only can create a WAL shm file.
  const staging = path.join(source, ".effectory", "blobs", ".binary-staging");
  if (!restoring && existsSync(staging) && readdirSync(staging).length > 0) {
    throw failure(
      "Conflict",
      "Unfinished binary installation work; run effectory daemon start then effectory daemon stop before backup. If recovery fails, fix its reported cause or make a verified offline filesystem copy."
    );
  }
  const files = await inventory(source);
  if (restoring) {
    verify(readManifest(source).files, files);
  } else if (existsSync(path.join(source, manifestName))) {
    throw failure("Conflict", "Source already contains a snapshot manifest");
  }
  if (
    !files.some((file) => file.path === "effectory.ts") ||
    !files.some((file) => file.path === ".effectory/state.sqlite")
  ) {
    throw failure(
      "InvalidInput",
      "Repository has no application entrypoint or state database"
    );
  }
  // mkdir is exclusive: never overwrite or merge into an existing destination.
  mkdirSync(destination, { mode: 0o700 });
  let completed = false;
  try {
    writeFileSync(
      path.join(destination, snapshotMarker),
      "Copy in progress\n",
      { flag: "wx", mode: 0o600 }
    );
    flush(path.join(destination, snapshotMarker));
    flush(destination);
    for (const file of files) {
      lease.assertActive();
      const filename = path.join(destination, file.path);
      mkdirSync(path.dirname(filename), { mode: 0o700, recursive: true });
      await copyFile(path.join(source, file.path), filename);
      await chmod(filename, file.executable ? 0o700 : 0o600);
      const copied = digestFile(filename);
      if (copied.bytes !== file.bytes || copied.digest !== file.digest) {
        throw failure("Conflict", "Source changed while copying its snapshot");
      }
      flush(filename);
      flush(path.dirname(filename));
    }
    verify(files, await inventory(source));
    lease.assertActive();
    if (!restoring) {
      const manifest = JSON.stringify({
        createdAt: new Date().toISOString(),
        files,
        format: 1,
      });
      if (Buffer.byteLength(manifest) > 16_777_216) {
        throw failure("LimitExceeded", "Snapshot manifest exceeds 16 MiB");
      }
      writeFileSync(path.join(destination, manifestName), manifest, {
        flag: "wx",
        mode: 0o600,
      });
      flush(path.join(destination, manifestName));
    }
    unlinkSync(path.join(destination, snapshotMarker));
    flush(destination);
    flush(path.dirname(destination));
    completed = true;
    return {
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      destination,
      files: files.length,
      restored: restoring,
    };
  } finally {
    if (!completed) {
      await rm(destination, { force: true, recursive: true });
    }
  }
}

/** Offline local operation; no application or extension code is evaluated. */
export function repositorySnapshot(
  source: string,
  destination: string,
  restoring: boolean
) {
  return Effect.gen(function* () {
    const locations = yield* Effect.try({
      catch: (cause) => storageError(cause, "Snapshot paths are unavailable"),
      try: () => {
        const root = realpathSync(source);
        const target = path.join(
          realpathSync(path.dirname(path.resolve(destination))),
          path.basename(destination)
        );
        const relative = path.relative(root, target);
        if (
          relative === "" ||
          (!relative.startsWith(`..${path.sep}`) &&
            relative !== ".." &&
            !path.isAbsolute(relative))
        ) {
          throw failure(
            "InvalidInput",
            "Snapshot destination must be outside its source"
          );
        }
        if (existsSync(target)) {
          throw failure("Conflict", "Snapshot destination already exists");
        }
        if (!existsSync(path.join(root, ".effectory/state.sqlite"))) {
          throw failure("NotFound", "Source repository database is missing");
        }
        return { root, target };
      },
    });
    return yield* Effect.gen(function* () {
      const lease = yield* RepositoryLease;
      return yield* Effect.tryPromise({
        catch: (cause) =>
          storageError(cause, "Snapshot copy or verification failed"),
        try: () =>
          copySnapshot(locations.root, locations.target, restoring, lease),
      });
    }).pipe(
      // Keep ownership until in-flight file operations finish, including on Ctrl-C.
      Effect.uninterruptible,
      Effect.provide(
        ownershipLayer(
          path.join(locations.root, ".effectory/state.sqlite.owner")
        )
      ),
      Effect.mapError((cause) =>
        storageError(
          cause,
          "Offline snapshot requires exclusive repository ownership and readable storage"
        )
      )
    );
  });
}

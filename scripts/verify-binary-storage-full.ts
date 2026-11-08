/* oxlint-disable no-await-in-loop -- Disposable image setup and teardown must be sequential. */
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Artifact } from "@offtree/effectory-sdk";
import { Effect, Schema, Stream } from "effect";

import { createStore } from "../packages/platform-bun/src/host-store.ts";
import { stagingDirectory } from "../packages/platform-bun/src/lake-binary.ts";
import { createLake } from "../packages/platform-bun/src/lake.ts";

// Opt-in real ENOSPC proof. Only this script's fresh 64 MiB disk image is filled.
// It never selects, resizes, erases, or writes an existing disk or mount point.
if (process.platform !== "darwin") {
  throw new Error(
    "This proof requires macOS hdiutil; no existing disk is used"
  );
}
const directory = mkdtempSync(path.join(tmpdir(), "effectory-enospc-"));
const image = path.join(directory, "proof.sparseimage");
const mount = path.join(directory, "mounted");
mkdirSync(mount, { mode: 0o700 });
let attached = false;
let database: Database | undefined;

async function hdiutil(args: string[]) {
  const child = Bun.spawn(["/usr/bin/hdiutil", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) {
      throw new Error(`hdiutil ${args[0]} exited ${code}: ${stderr || stdout}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

try {
  await hdiutil([
    "create",
    "-size",
    "64m",
    "-type",
    "SPARSE",
    "-fs",
    "HFS+",
    "-volname",
    "EffectoryENOSPC",
    image,
  ]);
  await hdiutil(["attach", image, "-nobrowse", "-mountpoint", mount]);
  attached = true;
  const capacity = statfsSync(mount);
  assert.ok(capacity.blocks * capacity.bsize <= 64 * 1024 * 1024);
  database = new Database(path.join(mount, "state.sqlite"));
  const db = database;
  const lease = {
    assertActive: () => assert.ok(attached, "Probe image must remain attached"),
    token: "enospc-proof",
  };
  const store = createStore(db, lease);
  const blobs = path.join(mount, "blobs");
  const lake = createLake(db, blobs, lease);
  const artifact = Artifact.make({
    contentType: "application/octet-stream",
    id: "proof/enospc",
    kind: "bytes",
    version: 1,
  });
  const producer = (key: string) =>
    Effect.gen(function* () {
      const run = yield* store.submit(
        {
          input: null,
          kind: "task",
          requestKey: key,
          targetId: "proof",
        },
        "revision",
        "owner"
      );
      yield* store.admitAttempt(run.runId, "publish", 1, "idempotent");
      return {
        attempt: 1,
        attemptId: `${run.runId}/publish/1`,
        invocationPath: "publish",
        revision: "revision",
        runId: run.runId,
        taskId: "proof",
        taskVersion: 1,
      };
    });
  const prepared = await Effect.runPromise(
    Effect.gen(function* () {
      const retainedProducer = yield* producer("retained");
      const retained = yield* lake.publishBytes(
        retainedProducer,
        "bytes",
        artifact,
        Stream.succeed(new Uint8Array(65_536).fill(17)),
        { key: "retained" }
      );
      yield* store.project(retainedProducer.runId, "Succeeded");
      const failingProducer = yield* producer("will-fill-image");
      return { failingProducer, retained };
    })
  );

  const filler = path.join(mount, "owned-filler");
  const descriptor = openSync(filler, "wx", 0o600);
  let fillerBytes = 0;
  try {
    const buffer = new Uint8Array(65_536).fill(111);
    for (;;) {
      const stat = statfsSync(mount);
      if (stat.bavail * stat.bsize <= 2 * 1024 * 1024) {
        break;
      }
      assert.ok(fillerBytes < 64 * 1024 * 1024, "Filler bound exceeded");
      fillerBytes += writeSync(descriptor, buffer);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  let consumedChunks = 0;
  const source = Stream.range(0, 255).pipe(
    Stream.rechunk(1),
    Stream.map(() => {
      consumedChunks += 1;
      return new Uint8Array(65_536).fill(23);
    })
  );
  const result = await Effect.runPromise(
    Effect.result(
      lake.publishBytes(prepared.failingProducer, "bytes", artifact, source, {
        key: "recover",
      })
    )
  );
  assert.equal(result._tag, "Failure");
  if (result._tag !== "Failure") {
    throw new Error("Publication unexpectedly succeeded");
  }
  assert.equal(result.failure.code, "StorageFull");
  // Failure happened while consuming bytes, before the install/metadata phase.
  assert.ok(consumedChunks > 0 && consumedChunks < 256);
  const row = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))(
    db.query("SELECT COUNT(*) AS count FROM lake_records").get()
  );
  assert.equal(row.count, 1, "A partial version became visible");
  assert.deepEqual(
    readdirSync(stagingDirectory(blobs)),
    [],
    "Staging leaked after ENOSPC"
  );
  assert.equal(
    db.query("SELECT stage FROM lake_binary_installs LIMIT 1").get(),
    null
  );

  unlinkSync(filler);
  const recovered = await Effect.runPromise(
    Effect.gen(function* () {
      const plan = yield* lake.planReclamation({
        _tag: "Version",
        artifactId: prepared.retained.artifactId,
        version: prepared.retained.version,
      });
      const receipt = yield* lake.applyReclamation({ planId: plan.planId });
      assert.equal(receipt.reclaimedBytes, 65_536);
      const reference = yield* lake.publishBytes(
        prepared.failingProducer,
        "bytes",
        artifact,
        Stream.succeed(new Uint8Array(1_048_576).fill(23)),
        { key: "recover" }
      );
      const frames = yield* lake
        .download(reference.artifactId, reference.version)
        .pipe(Stream.runCollect);
      const length = frames.reduce(
        (sum, frame) => sum + (frame._tag === "Bytes" ? frame.bytes.length : 0),
        0
      );
      assert.equal(length, 1_048_576);
      return { publishedBytes: length, reclaimedBytes: receipt.reclaimedBytes };
    })
  );
  process.stdout.write(
    `${JSON.stringify({
      capacityBytes: capacity.blocks * capacity.bsize,
      consumedChunks,
      failure: result.failure.code,
      filesystem: "HFS+",
      fillerBytes,
      partialVersions: 0,
      passed: true,
      stagingEntries: 0,
      ...recovered,
    })}\n`
  );
} finally {
  try {
    database?.close();
  } finally {
    // Detect even a partially successful attach before touching this private tree.
    attached ||= statSync(mount).dev !== statSync(directory).dev;
    if (attached) {
      try {
        await hdiutil(["detach", mount]);
        attached = false;
      } catch {
        await hdiutil(["detach", "-force", mount]);
        attached = false;
      }
    }
    // A failed detach preserves the image/path rather than touching a mounted tree.
    if (!attached) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
}

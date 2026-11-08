/* oxlint-disable no-bitwise -- O_NOFOLLOW protects metadata-only file inspection. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import { digestOf } from "./application-bundle.ts";
import { RepositoryLease } from "./ownership.ts";
import { RevisionManifest } from "./revision-manifest.ts";
import type { RevisionReclaimCandidate } from "./revision-reclaim-record.ts";
import { revisionReclaimError } from "./revision-reclaim-record.ts";
import { missingUpgradeFile } from "./upgrade-record-file.ts";

const unavailable = () =>
  revisionReclaimError(
    "RevisionUnavailable",
    "Retained revision files are unsupported, changed or damaged; no bundle was reclaimed"
  );
const io = <A>(body: () => A) =>
  Effect.try({
    catch: (cause) => (cause instanceof OperationError ? cause : unavailable()),
    try: body,
  });

/** Bounded descriptor read; hard links are allowed but symlinks never are. */
export function readReclaimFile(filename: string, maximum: number) {
  const initial = lstatSync(filename);
  if (!initial.isFile() || initial.size > maximum) {
    throw unavailable();
  }
  const descriptor = openSync(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== initial.dev || opened.ino !== initial.ino) {
      throw unavailable();
    }
    const buffer = Buffer.alloc(initial.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        null
      );
      if (count === 0) {
        break;
      }
      offset += count;
    }
    const final = fstatSync(descriptor);
    const current = lstatSync(filename);
    if (
      offset !== initial.size ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs ||
      !current.isFile() ||
      current.dev !== initial.dev ||
      current.ino !== initial.ino
    ) {
      throw unavailable();
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

/** No application import, compatibility assertion, SQLite open or directory cleanup. */
export function inventoryReclaimRevisions(repository: string) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const directory = path.join(repository, ".effectory", "revisions");
    const names = yield* io(() => {
      lease.assertActive();
      try {
        if (!lstatSync(directory).isDirectory()) {
          throw unavailable();
        }
      } catch (error) {
        if (missingUpgradeFile(error)) {
          return [];
        }
        throw error;
      }
      const retained = readdirSync(directory)
        .filter((name) => /^[a-f0-9]{64}$/u.test(name))
        .toSorted();
      if (retained.length > 256) {
        throw revisionReclaimError(
          "LimitExceeded",
          "Application revision directory limit reached"
        );
      }
      return retained;
    });
    const result: (typeof RevisionReclaimCandidate.Type)[] = [];
    for (const revision of names) {
      const candidate = yield* io(() => {
        lease.assertActive();
        const location = path.join(directory, revision);
        if (!lstatSync(location).isDirectory()) {
          throw unavailable();
        }
        let manifestBytes: Buffer;
        try {
          manifestBytes = readReclaimFile(
            path.join(location, "manifest.json"),
            65_536
          );
        } catch (error) {
          // Incomplete preparations are owned by normal catalog recovery.
          if (missingUpgradeFile(error)) {
            return null;
          }
          throw error;
        }
        const entries = readdirSync(location).toSorted();
        if (
          entries.length !== 2 ||
          entries[0] !== "application.mjs" ||
          entries[1] !== "manifest.json"
        ) {
          throw unavailable();
        }
        const manifest = Schema.decodeUnknownSync(RevisionManifest)(
          JSON.parse(manifestBytes.toString("utf-8")),
          { onExcessProperty: "error" }
        );
        const bundle = readReclaimFile(
          path.join(location, "application.mjs"),
          16_777_216
        );
        if (
          digestOf(bundle) !== manifest.digest ||
          digestOf(`${manifest.hostAbi}/${manifest.digest}`) !== revision
        ) {
          throw unavailable();
        }
        return {
          bundleDigest: manifest.digest,
          bytes: bundle.length + manifestBytes.length,
          executionContract:
            manifest.format === 3 ? manifest.executionContract : null,
          hostBuild: manifest.hostAbi,
          manifestDigest: digestOf(manifestBytes),
          revision,
        };
      });
      if (candidate !== null) {
        result.push(candidate);
      }
      if (result.length > 128) {
        return yield* revisionReclaimError(
          "LimitExceeded",
          "Retained application revision limit reached (128)"
        );
      }
      yield* Effect.yieldNow;
    }
    return result;
  });
}

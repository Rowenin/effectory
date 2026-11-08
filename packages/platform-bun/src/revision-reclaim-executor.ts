import {
  lstatSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import { digestOf } from "./application-bundle.ts";
import { RepositoryLease } from "./ownership.ts";
import { RevisionManifest } from "./revision-manifest.ts";
import { readReclaimFile } from "./revision-reclaim-inventory.ts";
import { makeReclaimJournal } from "./revision-reclaim-journal.ts";
import type { RevisionReclaimCandidate } from "./revision-reclaim-record.ts";
import { revisionReclaimError } from "./revision-reclaim-record.ts";
import { StoredCredentials } from "./runtime-storage-format.ts";
import { decodeFenceFile } from "./upgrade-file-fence.ts";
import {
  flushUpgradePath,
  missingUpgradeFile,
  readUpgradeFile,
  upgradeDirectory,
  writeUpgradeFile,
} from "./upgrade-record-file.ts";

const changed = () =>
  revisionReclaimError(
    "RevisionUnavailable",
    "Accepted revision deletion encountered missing, changed or unrelated files; preserve the journal and quarantine for recovery"
  );
function present(filename: string) {
  try {
    lstatSync(filename);
    return true;
  } catch (error) {
    if (missingUpgradeFile(error)) {
      return false;
    }
    throw error;
  }
}
function members(directory: string, allowed: readonly string[]) {
  if (!upgradeDirectory(directory, false)) {
    throw changed();
  }
  const names = readdirSync(directory);
  if (names.some((name) => !allowed.includes(name))) {
    throw changed();
  }
  return names;
}
function manifest(
  directory: string,
  candidate: typeof RevisionReclaimCandidate.Type
) {
  const bytes = readReclaimFile(path.join(directory, "manifest.json"), 65_536);
  if (digestOf(bytes) !== candidate.manifestDigest) {
    throw changed();
  }
  const value = Schema.decodeUnknownSync(RevisionManifest)(
    JSON.parse(bytes.toString("utf-8")),
    { onExcessProperty: "error" }
  );
  if (
    value.hostAbi !== candidate.hostBuild ||
    value.digest !== candidate.bundleDigest ||
    digestOf(`${value.hostAbi}/${value.digest}`) !== candidate.revision
  ) {
    throw changed();
  }
  return bytes.length;
}
function bundle(
  directory: string,
  candidate: typeof RevisionReclaimCandidate.Type,
  manifestBytes: number
) {
  const bytes = readReclaimFile(
    path.join(directory, "application.mjs"),
    16_777_216
  );
  if (
    digestOf(bytes) !== candidate.bundleDigest ||
    bytes.length + manifestBytes !== candidate.bytes
  ) {
    throw changed();
  }
}

/** Resumes only an accepted intent. There is no automatic startup invocation. */
export function reclaimRevisionFiles(
  repository: string,
  planId: string,
  build: string,
  step: (name: string) => Effect.Effect<void> = () => Effect.void
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const journal = yield* makeReclaimJournal(repository, step);
    const saved = yield* journal.inspect(planId);
    if (saved._tag !== "Accepted") {
      return yield* revisionReclaimError(
        "Conflict",
        "Revision deletion has not been accepted"
      );
    }
    const { acceptance, preview } = saved.transition;
    // A completed retry never inspects or deletes a recreated bundle.
    if (saved.transition.phase === "Complete") {
      if (
        acceptance.targetBuild === build &&
        acceptance.platform === process.platform &&
        acceptance.architecture === process.arch
      ) {
        return (yield* journal.release(planId, build)).receipt;
      }
      return saved.transition.receipt;
    }
    if (
      acceptance.targetBuild !== build ||
      acceptance.platform !== process.platform ||
      acceptance.architecture !== process.arch
    ) {
      return yield* revisionReclaimError(
        "RevisionUnavailable",
        `Resume revision reclamation ${planId} using accepting host ${acceptance.targetBuild} on ${acceptance.platform}/${acceptance.architecture}`
      );
    }
    const io = <A>(body: () => A) =>
      Effect.try({
        catch: (cause) =>
          cause instanceof OperationError
            ? cause
            : revisionReclaimError(
                "Unavailable",
                `Revision deletion ${planId} remains unfinished; correct the filesystem problem and retry effectory revision reclaim apply ${planId}`
              ),
        try: () => {
          lease.assertActive();
          return body();
        },
      });
    const state = path.join(repository, ".effectory");
    const revisions = path.join(state, "revisions");
    const control = path.join(state, "revision-reclaims");
    const quarantineRoot = path.join(control, "quarantine");
    const quarantine = path.join(quarantineRoot, planId);
    yield* io(() => {
      const credentials = decodeFenceFile(
        "Credentials",
        readUpgradeFile(path.join(state, "credentials.json"), 135_168)
      );
      if (
        credentials.contents === null ||
        Schema.decodeUnknownSync(StoredCredentials)(
          JSON.parse(credentials.contents),
          { onExcessProperty: "error" }
        ).repositoryId !== preview.plan.repositoryId
      ) {
        throw changed();
      }
      if (
        !upgradeDirectory(revisions, false) ||
        !upgradeDirectory(control, false)
      ) {
        throw changed();
      }
      upgradeDirectory(quarantineRoot, true);
      upgradeDirectory(quarantine, true);
      members(
        quarantine,
        preview.plan.candidates.map((candidate) => candidate.revision)
      );
    });
    for (const candidate of preview.plan.candidates) {
      const source = path.join(revisions, candidate.revision);
      const target = path.join(quarantine, candidate.revision);
      const initial = saved.transition.progress.find(
        (item) => item.revision === candidate.revision
      );
      if (!initial) {
        return yield* changed();
      }
      let { phase } = initial;
      if (phase === "Pending") {
        yield* io(() => {
          const atSource = present(source);
          const atTarget = present(target);
          if (atSource === atTarget) {
            throw changed();
          }
          const location = atSource ? source : target;
          if (
            members(location, ["application.mjs", "manifest.json"]).length !== 2
          ) {
            throw changed();
          }
          bundle(location, candidate, manifest(location, candidate));
          if (atSource) {
            renameSync(source, target);
          }
        });
        yield* step("renamed");
        yield* io(() => {
          flushUpgradePath(revisions);
          flushUpgradePath(quarantine);
        });
        yield* step("rename-synced");
        yield* journal.advance(
          planId,
          build,
          candidate.revision,
          "Quarantined"
        );
        phase = "Quarantined";
      }
      yield* io(() => {
        if (present(source)) {
          throw changed();
        }
      });
      if (phase === "Quarantined") {
        yield* io(() => {
          const names = members(target, ["application.mjs", "manifest.json"]);
          if (!names.includes("manifest.json")) {
            throw changed();
          }
          const manifestBytes = manifest(target, candidate);
          if (names.includes("application.mjs")) {
            bundle(target, candidate, manifestBytes);
            unlinkSync(path.join(target, "application.mjs"));
          }
        });
        yield* step("bundle-unlinked");
        yield* io(() => flushUpgradePath(target));
        yield* step("bundle-unlink-synced");
        yield* journal.advance(
          planId,
          build,
          candidate.revision,
          "BundleRemoved"
        );
        phase = "BundleRemoved";
      }
      if (phase === "BundleRemoved") {
        yield* io(() => {
          const names = members(target, ["manifest.json"]);
          if (names.includes("manifest.json")) {
            manifest(target, candidate);
            unlinkSync(path.join(target, "manifest.json"));
          }
        });
        yield* step("manifest-unlinked");
        yield* io(() => flushUpgradePath(target));
        yield* step("manifest-unlink-synced");
        yield* journal.advance(
          planId,
          build,
          candidate.revision,
          "ManifestRemoved"
        );
        phase = "ManifestRemoved";
      }
      if (phase === "ManifestRemoved") {
        yield* io(() => {
          if (present(target)) {
            members(target, []);
            rmdirSync(target);
          }
        });
        yield* step("directory-removed");
        yield* io(() => flushUpgradePath(quarantine));
        yield* step("directory-removal-synced");
        yield* journal.advance(planId, build, candidate.revision, "Complete");
      }
      yield* io(() => {
        if (present(target)) {
          throw changed();
        }
      });
      yield* Effect.yieldNow;
    }
    yield* io(() => {
      members(quarantine, []);
      rmdirSync(quarantine);
      flushUpgradePath(quarantineRoot);
      const deleted = path.join(control, "deleted");
      upgradeDirectory(deleted, true);
      for (const candidate of preview.plan.candidates) {
        writeUpgradeFile(
          path.join(deleted, `${candidate.revision}.json`),
          JSON.stringify({ format: 1, planId, revision: candidate.revision }),
          65_536,
          true
        );
      }
    });
    yield* step("quarantine-cleared");
    const completed = yield* journal.complete(planId, build, Date.now());
    yield* journal.release(planId, build);
    return completed.receipt;
  }).pipe(
    Effect.catchTag("OperationError", (failure) =>
      Effect.fail(
        failure.code === "StorageFull"
          ? revisionReclaimError(
              "Unavailable",
              `Revision deletion ${planId} remains unfinished; free external space and retry effectory revision reclaim apply ${planId}`
            )
          : failure
      )
    )
  );
}

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";

import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import { Effect, Schema } from "effect";

import { RepositoryLease } from "./ownership.ts";
import {
  ReclaimAcceptance,
  ReclaimPreview,
  ReclaimProgress,
  ReclaimTransition,
  invalidReclaimRecord,
  validateReclaimPreview,
} from "./revision-reclaim-journal-record.ts";
import {
  RevisionReclaimId,
  revisionReclaimError,
} from "./revision-reclaim-record.ts";
import { storageError } from "./storage-error.ts";
import {
  readUpgradeFile,
  removeUpgradeFile,
  upgradeDirectory,
  writeUpgradeFile,
} from "./upgrade-record-file.ts";
import { assertUpgradeIdle } from "./upgrade-transition-gate.ts";

const limit = 2_097_152;
const gateLimit = 65_536;
const fingerprint = (value: typeof ReclaimPreview.Type) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const decode = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  text: string
): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(text), {
      onExcessProperty: "error",
    });
  } catch {
    throw invalidReclaimRecord();
  }
};
const checkId = (id: string) => {
  if (!Schema.is(RevisionReclaimId)(id)) {
    throw revisionReclaimError(
      "InvalidInput",
      "Invalid revision reclamation plan ID"
    );
  }
  return id;
};

function validateTransition(value: typeof ReclaimTransition.Type) {
  const { acceptance, preview, progress, receipt } = value;
  const { plan } = validateReclaimPreview(preview);
  if (
    plan.status !== "Ready" ||
    acceptance.planId !== plan.planId ||
    acceptance.planDigest !== fingerprint(preview) ||
    acceptance.targetBuild !== plan.hostBuild ||
    acceptance.platform !== preview.platform ||
    acceptance.architecture !== preview.architecture ||
    progress.length !== plan.candidates.length ||
    progress.some(
      (item, index) => item.revision !== plan.candidates[index]?.revision
    )
  ) {
    throw invalidReclaimRecord();
  }
  if (value.phase === "Complete") {
    if (
      receipt === null ||
      progress.some((item) => item.phase !== "Complete") ||
      receipt.planId !== plan.planId ||
      receipt.startedAt !== acceptance.acceptedAt ||
      Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt) ||
      receipt.logicalBytes !== plan.logicalBytes ||
      receipt.removedFiles !== progress.length * 2 ||
      receipt.revisions.join(",") !==
        progress.map((item) => item.revision).join(",")
    ) {
      throw invalidReclaimRecord();
    }
  } else if (receipt !== null) {
    throw invalidReclaimRecord();
  }
  return value;
}

const own = (transition: typeof ReclaimTransition.Type, build: string) => {
  if (
    transition.acceptance.targetBuild !== build ||
    transition.acceptance.platform !== process.platform ||
    transition.acceptance.architecture !== process.arch
  ) {
    throw revisionReclaimError(
      "RevisionUnavailable",
      `Revision reclamation ${transition.acceptance.planId} requires accepting host ${transition.acceptance.targetBuild} on ${transition.acceptance.platform}/${transition.acceptance.architecture}`
    );
  }
};

/** File-only control state. It never removes bundles or resumes deletion itself. */
export function makeReclaimJournal(
  repository: string,
  step: (name: string) => Effect.Effect<void> = () => Effect.void
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const state = path.join(repository, ".effectory");
    const control = path.join(state, "revision-reclaims");
    const plans = path.join(control, "plans");
    const history = path.join(control, "history");
    const gates = path.join(state, "upgrades");
    const gateFile = path.join(gates, "active.json");
    const io = <A>(body: () => A) =>
      Effect.try({
        catch: (cause) =>
          storageError(cause, "Revision reclamation journal is unavailable"),
        try: () => {
          lease.assertActive();
          return body();
        },
      });
    const directories = (create: boolean) => {
      if (!upgradeDirectory(state, false)) {
        throw invalidReclaimRecord();
      }
      return upgradeDirectory(control, create);
    };
    const gate = () => {
      if (!upgradeDirectory(gates, false)) {
        return null;
      }
      const text = readUpgradeFile(gateFile, gateLimit);
      return text === null ? null : decode(ReclaimAcceptance, text);
    };
    const preview = (id: string) => {
      checkId(id);
      if (!directories(false) || !upgradeDirectory(plans, false)) {
        return null;
      }
      const text = readUpgradeFile(path.join(plans, `${id}.json`), limit);
      if (text === null) {
        return null;
      }
      const value = validateReclaimPreview(decode(ReclaimPreview, text));
      if (value.plan.planId !== id) {
        throw invalidReclaimRecord();
      }
      return value;
    };
    const read = (id: string) => {
      checkId(id);
      if (directories(false) && upgradeDirectory(history, false)) {
        const text = readUpgradeFile(path.join(history, `${id}.json`), limit);
        if (text !== null) {
          const transition = validateTransition(
            decode(ReclaimTransition, text)
          );
          if (transition.preview.plan.planId !== id) {
            throw invalidReclaimRecord();
          }
          if (
            transition.phase !== "Complete" &&
            canonical(gate()) !== canonical(transition.acceptance)
          ) {
            throw invalidReclaimRecord();
          }
          return { _tag: "Accepted" as const, transition };
        }
      }
      const saved = preview(id);
      const pending = gate();
      if (pending?.planId === id) {
        if (saved === null) {
          throw invalidReclaimRecord();
        }
        return {
          _tag: "Accepted" as const,
          transition: validateTransition({
            acceptance: pending,
            format: 1,
            phase: "Applying",
            preview: saved,
            progress: saved.plan.candidates.map((candidate) => ({
              phase: "Pending",
              revision: candidate.revision,
            })),
            receipt: null,
          }),
        };
      }
      return saved === null
        ? null
        : { _tag: "Planned" as const, preview: saved };
    };
    const write = (transition: typeof ReclaimTransition.Type) => {
      validateTransition(transition);
      directories(true);
      upgradeDirectory(history, true);
      writeUpgradeFile(
        path.join(history, `${transition.acceptance.planId}.json`),
        JSON.stringify(transition),
        limit,
        true
      );
    };
    const accepted = (id: string, build: string) => {
      const saved = read(id);
      if (saved?._tag !== "Accepted") {
        throw revisionReclaimError(
          "Conflict",
          "Revision deletion has not been accepted"
        );
      }
      own(saved.transition, build);
      return saved.transition;
    };
    return {
      accept: (id: string, binding: string, build: string, now: number) =>
        Effect.gen(function* () {
          const transition = yield* io(() => {
            const saved = read(id);
            if (saved?._tag === "Accepted") {
              return saved.transition;
            }
            assertUpgradeIdle(repository);
            if (saved === null) {
              throw revisionReclaimError(
                "NotFound",
                "Revision reclamation plan was not found"
              );
            }
            const value = saved.preview;
            if (
              value.plan.status !== "Ready" ||
              Date.parse(value.plan.expiresAt) <= now ||
              value.binding !== binding ||
              value.plan.hostBuild !== build ||
              value.platform !== process.platform ||
              value.architecture !== process.arch
            ) {
              throw revisionReclaimError(
                "Conflict",
                "Revision reclamation preview expired, changed or belongs to another host; plan again before applying"
              );
            }
            const acceptance: typeof ReclaimAcceptance.Type = {
              acceptedAt: new Date(now).toISOString(),
              architecture: process.arch,
              format: 2,
              kind: "RevisionReclaim",
              planDigest: fingerprint(value),
              planId: id,
              platform: process.platform,
              targetBuild: build,
            };
            upgradeDirectory(gates, true);
            writeUpgradeFile(
              gateFile,
              JSON.stringify(acceptance),
              gateLimit,
              false
            );
            return validateTransition({
              acceptance,
              format: 1,
              phase: "Applying",
              preview: value,
              progress: value.plan.candidates.map((candidate) => ({
                phase: "Pending",
                revision: candidate.revision,
              })),
              receipt: null,
            });
          });
          yield* step("accepted");
          return transition;
        }),
      advance: (
        id: string,
        build: string,
        revision: string,
        phase: typeof ReclaimProgress.Type
      ) =>
        Effect.gen(function* () {
          const transition = yield* io(() => {
            const value = accepted(id, build);
            const item = value.progress.find(
              (candidate) => candidate.revision === revision
            );
            if (!item || value.phase === "Complete") {
              throw revisionReclaimError(
                "Conflict",
                "Revision deletion progress is already complete or unknown"
              );
            }
            const steps = ReclaimProgress.literals;
            if (steps.indexOf(phase) !== steps.indexOf(item.phase) + 1) {
              throw revisionReclaimError(
                "Conflict",
                "Revision deletion progress cannot skip or repeat a boundary"
              );
            }
            const next = {
              ...value,
              progress: value.progress.map((candidate) =>
                candidate === item ? { ...candidate, phase } : candidate
              ),
            };
            write(next);
            return next;
          });
          yield* step(phase);
          return transition;
        }),
      complete: (id: string, build: string, now: number) =>
        Effect.gen(function* () {
          const transition = yield* io(() => {
            const value = accepted(id, build);
            if (value.phase === "Complete") {
              return value;
            }
            const next: typeof ReclaimTransition.Type = {
              ...value,
              phase: "Complete",
              receipt: {
                completedAt: new Date(now).toISOString(),
                logicalBytes: value.preview.plan.logicalBytes,
                planId: id,
                removedFiles: value.progress.length * 2,
                revisions: value.progress.map((item) => item.revision),
                startedAt: value.acceptance.acceptedAt,
              },
            };
            write(next);
            return next;
          });
          yield* step("receipt");
          return transition;
        }),
      inspect: (id: string) =>
        io(() => {
          const saved = read(id);
          if (saved === null) {
            throw revisionReclaimError(
              "NotFound",
              "Revision reclamation plan was not found"
            );
          }
          return saved;
        }),
      release: (id: string, build: string) =>
        Effect.gen(function* () {
          const transition = yield* io(() => {
            const value = accepted(id, build);
            if (value.phase !== "Complete") {
              throw revisionReclaimError(
                "Conflict",
                "Revision deletion must complete before releasing maintenance ownership"
              );
            }
            // A completed receipt remains readable while a different maintenance
            // operation is pending. It must not clear or rewrite that gate.
            const pendingText = upgradeDirectory(gates, false)
              ? readUpgradeFile(gateFile, gateLimit)
              : null;
            let pending: typeof ReclaimAcceptance.Type | null = null;
            if (pendingText !== null) {
              const decoded = Schema.decodeUnknownOption(ReclaimAcceptance)(
                JSON.parse(pendingText)
              );
              if (decoded._tag === "None" || decoded.value.planId !== id) {
                return value;
              }
              pending = decoded.value;
            }
            if (pending?.planId === id) {
              if (canonical(pending) !== canonical(value.acceptance)) {
                throw invalidReclaimRecord();
              }
              removeUpgradeFile(gateFile, gateLimit);
            }
            if (upgradeDirectory(plans, false)) {
              removeUpgradeFile(path.join(plans, `${id}.json`), limit);
            }
            return value;
          });
          yield* step("released");
          return transition;
        }),
      save: (input: typeof ReclaimPreview.Type, now: number) =>
        io(() => {
          assertUpgradeIdle(repository);
          const value = validateReclaimPreview(
            decode(ReclaimPreview, JSON.stringify(input))
          );
          directories(true);
          upgradeDirectory(plans, true);
          // Only previews live here; completed receipts never need enumeration.
          const names = readdirSync(plans);
          if (names.length > 128) {
            throw revisionReclaimError(
              "LimitExceeded",
              "Revision reclamation preview directory exceeds its bound"
            );
          }
          let live = 0;
          for (const name of names) {
            if (
              name.endsWith(".json.prepare") &&
              Schema.is(RevisionReclaimId)(name.slice(0, -13))
            ) {
              removeUpgradeFile(path.join(plans, name), limit);
              continue;
            }
            const id = name.endsWith(".json") ? name.slice(0, -5) : "";
            if (!Schema.is(RevisionReclaimId)(id)) {
              throw invalidReclaimRecord();
            }
            const prior = preview(id);
            if (prior === null) {
              throw invalidReclaimRecord();
            }
            if (Date.parse(prior.plan.expiresAt) <= now) {
              removeUpgradeFile(path.join(plans, name), limit);
            } else {
              live += 1;
            }
          }
          if (live >= 32) {
            throw revisionReclaimError(
              "LimitExceeded",
              "At most 32 live revision reclamation previews are retained; wait for previews to expire"
            );
          }
          if (
            directories(false) &&
            upgradeDirectory(history, false) &&
            readUpgradeFile(
              path.join(history, `${value.plan.planId}.json`),
              limit
            ) !== null
          ) {
            throw revisionReclaimError(
              "Conflict",
              "Revision reclamation plan ID was already accepted"
            );
          }
          writeUpgradeFile(
            path.join(plans, `${value.plan.planId}.json`),
            JSON.stringify(value),
            limit,
            false
          );
          return value;
        }),
    };
  });
}

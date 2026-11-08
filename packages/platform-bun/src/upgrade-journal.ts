import { createHash } from "node:crypto";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import { Effect, Schema } from "effect";

import { RepositoryLease } from "./ownership.ts";
import { storageError } from "./storage-error.ts";
import {
  readUpgradeFile,
  removeUpgradeFile,
  upgradeDirectory,
  upgradeRecordFailure,
  writeUpgradeFile,
} from "./upgrade-record-file.ts";
import {
  UpgradeAcceptance,
  UpgradeId,
  UpgradePlan,
  UpgradeTransition,
  terminalUpgrade,
} from "./upgrade-record.ts";
import type { UpgradePhase } from "./upgrade-record.ts";

const planLimit = 2_097_152;
const historyLimit = 4_194_304;
const activeLimit = 65_536;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const conflict = (message: string) =>
  new OperationError({ code: "Conflict", message });
const decode = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  text: string
): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(text), {
      onExcessProperty: "error",
    });
  } catch {
    throw upgradeRecordFailure(
      "Upgrade record has an unsupported format; preserve it for its accepting host"
    );
  }
};
const nextPhase: Readonly<
  Record<typeof UpgradePhase.Type, readonly (typeof UpgradePhase.Type)[]>
> = {
  Aborted: [],
  Aborting: ["Aborted"],
  Complete: [],
  Fenced: ["Migrating", "Aborting"],
  Migrating: ["Publishing"],
  Protecting: ["Fenced", "Aborting"],
  Publishing: ["Complete"],
};
const id = (value: string) => {
  if (!Schema.is(UpgradeId)(value)) {
    throw new OperationError({
      code: "InvalidInput",
      message: "Invalid upgrade plan ID",
    });
  }
  return value;
};
const validate = (value: typeof UpgradeTransition.Type) => {
  const { acceptance, plan: source } = value;
  if (
    (value.abortReason !== undefined &&
      value.phase !== "Aborting" &&
      value.phase !== "Aborted") ||
    acceptance.planDigest !== digest(canonical(source)) ||
    acceptance.planId !== source.planId ||
    acceptance.targetBuild !== source.target.build ||
    value.updatedAt < acceptance.acceptedAt ||
    value.completedSteps.some(
      (item, index) => source.migrations[index] !== item
    ) ||
    value.completedSteps.length > source.migrations.length ||
    (value.phase === "Complete" &&
      value.completedSteps.length !== source.migrations.length)
  ) {
    throw upgradeRecordFailure(
      "Upgrade transition identity or progress is inconsistent"
    );
  }
  return value;
};
const target = (value: typeof UpgradeTransition.Type, build: string) => {
  if (
    value.acceptance.targetBuild !== build ||
    value.acceptance.platform !== process.platform ||
    value.acceptance.architecture !== process.arch
  ) {
    throw upgradeRecordFailure(
      `Upgrade ${value.plan.planId} requires its accepting host build ${value.acceptance.targetBuild} on ${value.acceptance.platform}/${value.acceptance.architecture}`
    );
  }
};
export type UpgradeJournalStep = (step: string) => Effect.Effect<void>;
const noStep: UpgradeJournalStep = () => Effect.void;

/**
 * Offline control records only: no database, application code, migration or
 * recovery-copy creation. The caller verifies policy/source/copy before accept.
 * Acceptance is durable before any migration is permitted. All methods check
 * the captured repository lease, including after an Effect yield.
 */
export function makeUpgradeJournal(
  repository: string,
  step: UpgradeJournalStep = noStep
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const state = path.join(repository, ".effectory");
    const control = path.join(state, "upgrades");
    const plans = path.join(control, "plans");
    // Prior accepted receipts belong in subsequent rollback copies. Temporary
    // plans/active pointer are excluded by upgrade-copy; history is not.
    const history = path.join(state, "upgrade-history");
    const activeFile = path.join(control, "active.json");
    const io = <A>(body: () => A) =>
      Effect.try({
        catch: (cause) =>
          storageError(cause, "Upgrade control storage is unavailable"),
        try: () => {
          lease.assertActive();
          return body();
        },
      });
    const directories = (create: boolean) => {
      if (!upgradeDirectory(state, false)) {
        throw upgradeRecordFailure("Repository state directory is missing");
      }
      if (!upgradeDirectory(control, create)) {
        return false;
      }
      return upgradeDirectory(plans, create);
    };
    const active = () => {
      if (
        !upgradeDirectory(state, false) ||
        !upgradeDirectory(control, false)
      ) {
        return null;
      }
      const text = readUpgradeFile(activeFile, activeLimit);
      return text === null ? null : decode(UpgradeAcceptance, text);
    };
    const plan = (planId: string) => {
      id(planId);
      if (!directories(false)) {
        return null;
      }
      const text = readUpgradeFile(
        path.join(plans, `${planId}.json`),
        planLimit
      );
      if (text === null) {
        return null;
      }
      const value = decode(UpgradePlan, text);
      if (
        value.planId !== planId ||
        value.expiresAt <= value.createdAt ||
        new Set(value.migrations).size !== value.migrations.length
      ) {
        throw upgradeRecordFailure(
          "Upgrade plan identity or lifetime is inconsistent"
        );
      }
      return { digest: digest(text), plan: value };
    };
    const read = (planId: string) => {
      id(planId);
      // Check all parents before reading any accepted record.
      if (!upgradeDirectory(state, false)) {
        return null;
      }
      if (upgradeDirectory(history, false)) {
        const text = readUpgradeFile(
          path.join(history, `${planId}.json`),
          historyLimit
        );
        if (text !== null) {
          const value = validate(decode(UpgradeTransition, text));
          if (value.plan.planId !== planId) {
            throw upgradeRecordFailure(
              "Upgrade history belongs to a different plan"
            );
          }
          if (!terminalUpgrade(value.phase)) {
            const pending = active();
            if (
              pending === null ||
              canonical(pending) !== canonical(value.acceptance)
            ) {
              throw upgradeRecordFailure(
                "Unfinished upgrade history has no matching active intent"
              );
            }
          }
          return { _tag: "Accepted" as const, transition: value };
        }
      }
      const pending = active();
      const preview = plan(planId);
      if (pending?.planId === planId) {
        if (
          preview === null ||
          preview.digest !== pending.planDigest ||
          preview.plan.target.build !== pending.targetBuild
        ) {
          throw upgradeRecordFailure(
            "Accepted upgrade is missing its immutable plan"
          );
        }
        return {
          _tag: "Accepted" as const,
          transition: validate({
            acceptance: pending,
            completedSteps: [],
            format: 1,
            phase: "Protecting",
            plan: preview.plan,
            updatedAt: pending.acceptedAt,
          }),
        };
      }
      return preview === null ? null : { _tag: "Planned" as const, ...preview };
    };
    const writeHistory = (value: typeof UpgradeTransition.Type) => {
      directories(true);
      upgradeDirectory(history, true);
      validate(value);
      writeUpgradeFile(
        path.join(history, `${value.plan.planId}.json`),
        JSON.stringify(value),
        historyLimit,
        true
      );
    };
    return {
      accept: (
        input: {
          readonly planId: string;
          readonly planDigest: string;
          readonly recoveryDigest: string;
          readonly sourceIdentity: string;
          readonly targetBuild: string;
        },
        now: number
      ) =>
        Effect.gen(function* () {
          const accepted = yield* io(() => {
            const prior = read(input.planId);
            // An accepted plan is resolved before expiry/source freshness. It is
            // immutable; a completed receipt can be inspected by a later host.
            if (prior?._tag === "Accepted") {
              if (!terminalUpgrade(prior.transition.phase)) {
                target(prior.transition, input.targetBuild);
              }
              return prior.transition;
            }
            if (prior === null) {
              throw new OperationError({
                code: "NotFound",
                message: "Upgrade plan was not found",
              });
            }
            if (active() !== null) {
              throw conflict("Another runtime upgrade is already accepted");
            }
            const value = prior.plan;
            if (value.status !== "Ready" || value.blockers.length > 0) {
              throw upgradeRecordFailure(
                "This upgrade plan is unsupported or has blocking work; it cannot be applied"
              );
            }
            if (
              now < value.createdAt ||
              now >= value.expiresAt ||
              input.planDigest !== prior.digest ||
              input.sourceIdentity !== value.source.identity ||
              input.targetBuild !== value.target.build
            ) {
              throw conflict(
                "Upgrade plan is stale; create a fresh plan before applying"
              );
            }
            const acceptance = decode(
              UpgradeAcceptance,
              JSON.stringify({
                acceptedAt: now,
                architecture: process.arch,
                format: 1,
                planDigest: prior.digest,
                planId: value.planId,
                platform: process.platform,
                recoveryDigest: input.recoveryDigest,
                targetBuild: input.targetBuild,
              })
            );
            writeUpgradeFile(
              activeFile,
              JSON.stringify(acceptance),
              activeLimit,
              false
            );
            return validate({
              acceptance,
              completedSteps: [],
              format: 1,
              phase: "Protecting",
              plan: value,
              updatedAt: now,
            });
          });
          yield* step("accepted");
          if (!terminalUpgrade(accepted.phase)) {
            yield* io(() => writeHistory(accepted));
            yield* step("history-published");
          }
          return accepted;
        }),
      checkpoint: (
        planId: string,
        build: string,
        update: {
          readonly phase?: typeof UpgradePhase.Type;
          readonly abortReason?: "SourceChanged";
          readonly completedStep?: string;
        },
        now: number
      ) =>
        Effect.gen(function* () {
          const value = yield* io(() => {
            const prior = read(planId);
            if (prior?._tag !== "Accepted") {
              throw conflict("Upgrade has not been accepted");
            }
            const current = prior.transition;
            target(current, build);
            const phase = update.phase ?? current.phase;
            if (
              phase !== current.phase &&
              !nextPhase[current.phase].includes(phase)
            ) {
              throw conflict("Invalid upgrade phase transition");
            }
            const steps = [...current.completedSteps];
            if (
              update.completedStep !== undefined &&
              update.completedStep !== steps.at(-1)
            ) {
              if (
                terminalUpgrade(current.phase) ||
                current.phase === "Aborting" ||
                current.plan.migrations[steps.length] !== update.completedStep
              ) {
                throw conflict("Upgrade migration checkpoint is out of order");
              }
              steps.push(update.completedStep);
            }
            if (terminalUpgrade(current.phase)) {
              return current;
            }
            if (now < current.updatedAt || !Number.isSafeInteger(now)) {
              throw conflict("Upgrade checkpoint time is invalid");
            }
            const next = validate({
              ...current,
              ...(update.abortReason === undefined
                ? {}
                : { abortReason: update.abortReason }),
              completedSteps: steps,
              phase,
              updatedAt: now,
            });
            writeHistory(next);
            return next;
          });
          yield* step("checkpoint-published");
          return value;
        }),
      inspect: (planId: string) =>
        io(() => {
          const value = read(planId);
          if (value === null) {
            throw new OperationError({
              code: "NotFound",
              message: "Upgrade plan was not found",
            });
          }
          return value;
        }),
      release: (planId: string, build: string) =>
        Effect.gen(function* () {
          const value = yield* io(() => {
            const prior = read(planId);
            if (
              prior?._tag !== "Accepted" ||
              !terminalUpgrade(prior.transition.phase)
            ) {
              throw conflict("Cannot release an unfinished upgrade intent");
            }
            target(prior.transition, build);
            const pending = active();
            if (pending !== null && pending.planId === planId) {
              if (
                canonical(pending) !== canonical(prior.transition.acceptance)
              ) {
                throw upgradeRecordFailure(
                  "Upgrade receipt does not match the active intent"
                );
              }
              removeUpgradeFile(activeFile, activeLimit);
            }
            // Accepted history now owns the complete plan; expired preview cleanup
            // may never remove its receipt. Deletion is safe to repeat after a kill.
            if (directories(false)) {
              removeUpgradeFile(path.join(plans, `${planId}.json`), planLimit);
            }
            return prior.transition;
          });
          yield* step("released");
          return value;
        }),
      savePlan: (value: typeof UpgradePlan.Type) =>
        io(() => {
          // Decode before any directory or record publication.
          const checked = decode(UpgradePlan, JSON.stringify(value));
          const text = canonical(checked);
          if (Buffer.byteLength(text) > planLimit) {
            throw new OperationError({
              code: "LimitExceeded",
              message: "Upgrade plan exceeds its 2 MiB storage budget",
            });
          }
          if (
            checked.expiresAt <= checked.createdAt ||
            new Set(checked.migrations).size !== checked.migrations.length
          ) {
            throw conflict(
              "Invalid upgrade plan lifetime or repeated migration"
            );
          }
          if (active() !== null) {
            throw conflict(
              "An accepted runtime upgrade must finish before planning another"
            );
          }
          directories(true);
          if (read(checked.planId) !== null) {
            throw conflict("Upgrade plan identity is already retained");
          }
          writeUpgradeFile(
            path.join(plans, `${checked.planId}.json`),
            text,
            planLimit,
            false
          );
          return { digest: digest(text), plan: checked };
        }),
    };
  });
}

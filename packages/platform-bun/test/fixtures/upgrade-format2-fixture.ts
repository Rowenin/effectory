import path from "node:path";

import { Effect } from "effect";

import { assessRuntimeUpgrade } from "../../src/upgrade-assessment.ts";
import { createUpgradeRecoveryCopy } from "../../src/upgrade-copy.ts";
import {
  acceptRuntimeUpgrade,
  resumeRuntimeUpgrade,
} from "../../src/upgrade-executor.ts";
import { fingerprintUpgradeRepository } from "../../src/upgrade-fingerprint.ts";
import { makeUpgradeJournal } from "../../src/upgrade-journal.ts";
import { executorTestPolicy } from "./upgrade-executor-policy.ts";
import { fenceFixture } from "./upgrade-fence-fixture.ts";

/** Real component migrations with a synthetic policy, never release certification. */
export async function format2Fixture(realVault: boolean) {
  const f = fenceFixture();
  try {
    if (realVault) {
      f.seed();
    }
    await f.run(
      Effect.gen(function* () {
        const identity = yield* fingerprintUpgradeRepository(f.repository);
        const j = yield* makeUpgradeJournal(f.repository);
        const saved = yield* j.savePlan({
          ...f.plan,
          source: {
            ...f.plan.source,
            dependencies: identity.dependencies,
            identity: identity.identity,
          },
        });
        const copy = yield* createUpgradeRecoveryCopy(
          f.repository,
          f.plan.recoveryCopy,
          f.plan.planId
        );
        const accepted = yield* j.accept(
          {
            planDigest: saved.digest,
            planId: f.plan.planId,
            recoveryDigest: copy.digest,
            sourceIdentity: identity.identity,
            targetBuild: f.plan.target.build,
          },
          2
        );
        yield* resumeRuntimeUpgrade(
          f.repository,
          accepted,
          executorTestPolicy(saved.plan),
          undefined,
          copy.manifest
        );
      })
    );
    const next = {
      ...f.plan,
      planId: crypto.randomUUID(),
      recoveryCopy: path.join(f.directory, "recovery-next"),
      source: { ...f.plan.source, build: f.plan.target.build, storage: 2 },
      target: { ...f.plan.target, build: "c".repeat(64), storage: 3 },
    };
    const policy = executorTestPolicy(next);
    const saved = await f.run(
      Effect.gen(function* () {
        const plan = yield* assessRuntimeUpgrade(
          f.repository,
          next.planId,
          policy
        );
        const j = yield* makeUpgradeJournal(f.repository);
        return yield* j.savePlan(plan);
      })
    );
    const owner = {
      planId: saved.plan.planId,
      targetBuild: saved.plan.target.build,
    };
    return {
      ...f,
      accept: (stage = "accepted") =>
        f.run(
          acceptRuntimeUpgrade(f.repository, saved, policy, (name) =>
            name === stage ? Effect.die("component checkpoint") : Effect.void
          ).pipe(Effect.exit)
        ),
      nextOwner: owner,
      policy,
      resume: () =>
        f.run(
          Effect.gen(function* () {
            const j = yield* makeUpgradeJournal(f.repository);
            const record = yield* j.inspect(saved.plan.planId);
            if (record._tag !== "Accepted") {
              throw new Error("Expected accepted format-2 fixture");
            }
            return yield* resumeRuntimeUpgrade(
              f.repository,
              record.transition,
              policy
            );
          })
        ),
      saved,
    };
  } catch (error) {
    f.cleanup();
    throw error;
  }
}

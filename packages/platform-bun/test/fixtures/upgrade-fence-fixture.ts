import { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";
import type { Scope } from "effect";

import { ownershipLayer } from "../../src/ownership.ts";
import type { Lease } from "../../src/ownership.ts";
import { makeUpgradeJournal } from "../../src/upgrade-journal.ts";
import { runtimeUpgradeSteps } from "../../src/upgrade-policy.ts";
import type { UpgradePlan } from "../../src/upgrade-record.ts";
import { VaultStore } from "../../src/vault-store.ts";

export function fenceFixture(build = "b".repeat(64)) {
  const directory = realpathSync(
    mkdtempSync(path.join(tmpdir(), "effectory-upgrade-fence-"))
  );
  const repository = path.join(directory, "repository");
  const state = path.join(repository, ".effectory");
  mkdirSync(state, { recursive: true });
  const previousKeys = process.env.EFFECTORY_KEY_DIR;
  process.env.EFFECTORY_KEY_DIR = path.join(directory, "keys");
  const credentials =
    ' { "token": "CANARY-fence-fixture", "repositoryId": "fixture" }\n';
  writeFileSync(path.join(state, "credentials.json"), credentials);
  const database = new Database(path.join(state, "state.sqlite"));
  database.exec("CREATE TABLE component_fixture(value TEXT)");
  database.close();
  const owner = { planId: crypto.randomUUID(), targetBuild: build };
  const own = ownershipLayer(path.join(state, "state.sqlite.owner"));
  const run = <A, E>(effect: Effect.Effect<A, E, Lease | Scope.Scope>) =>
    Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(own)));
  const plan: typeof UpgradePlan.Type = {
    blockers: [],
    createdAt: 1,
    expiresAt: 10,
    format: 1,
    migrations: [...runtimeUpgradeSteps],
    planId: owner.planId,
    recoveryCopy: path.join(directory, "recovery"),
    repositoryId: "fixture",
    revisions: [],
    source: {
      build: "a".repeat(64),
      dependencies: "a".repeat(64),
      identity: "a".repeat(64),
      storage: 1,
    },
    status: "Ready",
    target: {
      build: owner.targetBuild,
      contract: "fixture/v1",
      effect: "4.0.5",
      storage: 2,
    },
    work: {},
    workByRevision: [],
  };
  const accept = () =>
    run(
      Effect.gen(function* () {
        const journal = yield* makeUpgradeJournal(repository);
        const saved = yield* journal.savePlan(plan);
        // Component fixture only; executor tests must create and verify a real copy.
        yield* journal.accept(
          {
            planDigest: saved.digest,
            planId: owner.planId,
            recoveryDigest: "a".repeat(64),
            sourceIdentity: plan.source.identity,
            targetBuild: owner.targetBuild,
          },
          2
        );
      })
    );
  const finishAbort = () =>
    run(
      Effect.gen(function* () {
        const journal = yield* makeUpgradeJournal(repository);
        yield* journal.checkpoint(
          owner.planId,
          owner.targetBuild,
          { phase: "Aborting" },
          3
        );
        yield* journal.checkpoint(
          owner.planId,
          owner.targetBuild,
          { phase: "Aborted" },
          4
        );
        yield* journal.release(owner.planId, owner.targetBuild);
      })
    );
  const vault = () =>
    new VaultStore(repository, {
      assertActive() {
        /* Fixture setup runs without another writer. */
      },
      token: "fixture",
    });
  const seed = () => {
    const store = vault();
    try {
      store.init("credentials");
      store.mutate({
        expectedVersion: "0",
        key: "token",
        operation: "Put",
        requestKey: "seed",
        value: "CANARY-fence-fixture",
        vault: "credentials",
      });
    } finally {
      store.close();
    }
  };
  return {
    accept,
    cleanup() {
      if (previousKeys === undefined) {
        delete process.env.EFFECTORY_KEY_DIR;
      } else {
        process.env.EFFECTORY_KEY_DIR = previousKeys;
      }
      rmSync(directory, { force: true, recursive: true });
    },
    credentials,
    directory,
    finishAbort,
    own,
    owner,
    plan,
    repository,
    run,
    seed,
    state,
    vault,
  };
}

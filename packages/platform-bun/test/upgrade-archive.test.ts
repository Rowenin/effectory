import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect, Layer } from "effect";

import { Catalog } from "../src/catalog.ts";
import { hostAbi } from "../src/host-runtime.ts";
import { createStore } from "../src/host-store.ts";
import { revisionCatalogLayer } from "../src/revisions.ts";
import { executionContract } from "../src/runtime-compatibility.ts";
import { createUpgradeRecoveryCopy } from "../src/upgrade-copy.ts";
import { resumeRuntimeUpgrade } from "../src/upgrade-executor.ts";
import { fingerprintUpgradeRepository } from "../src/upgrade-fingerprint.ts";
import { makeUpgradeJournal } from "../src/upgrade-journal.ts";
import { preflightRuntime } from "../src/upgrade-preflight.ts";
import { executorTestPolicy } from "./fixtures/upgrade-executor-policy.ts";
import { fenceFixture } from "./fixtures/upgrade-fence-fixture.ts";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

test("archived bundles are never imported, stored runs remain readable, and execution-dependent access refuses", async () => {
  const f = fenceFixture(hostAbi());
  const oldBuild = "a".repeat(64);
  const application = "throw new Error('ARCHIVED CODE MUST NEVER BE IMPORTED')";
  const digest = hash(application);
  const revision = hash(`${oldBuild}/${digest}`);
  const directory = path.join(f.state, "revisions", revision);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "application.mjs"), application);
  writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      digest,
      effectVersion: "4.0.5",
      extensionDigests: [],
      format: 2,
      hostAbi: oldBuild,
    })
  );
  writeFileSync(
    path.join(f.repository, "effectory.ts"),
    'import { Application } from "@offtree/effectory-sdk"; export default Application.make({});'
  );
  const db = new Database(path.join(f.state, "state.sqlite"));
  const store = createStore(db, {
    assertActive() {
      /* Isolated fixture, no concurrent writer. */
    },
    token: "fixture",
  });
  try {
    const run = await Effect.runPromise(
      store.submit(
        {
          input: null,
          kind: "task",
          requestKey: "finished",
          targetId: "archived",
        },
        revision,
        "owner"
      )
    );
    await Effect.runPromise(
      store.project(run.runId, "Succeeded", { preserved: true })
    );
    db.exec("UPDATE host_outbox SET delivered=1");
    db.close();
    const accepted = await f.run(
      Effect.gen(function* () {
        const before = yield* fingerprintUpgradeRepository(f.repository);
        const journal = yield* makeUpgradeJournal(f.repository);
        const saved = yield* journal.savePlan({
          ...f.plan,
          source: {
            ...f.plan.source,
            dependencies: before.dependencies,
            identity: before.identity,
          },
          target: { ...f.plan.target, contract: executionContract },
        });
        const image = yield* createUpgradeRecoveryCopy(
          f.repository,
          f.plan.recoveryCopy,
          f.owner.planId
        );
        return yield* journal.accept(
          {
            planDigest: saved.digest,
            planId: f.owner.planId,
            recoveryDigest: image.digest,
            sourceIdentity: before.identity,
            targetBuild: f.owner.targetBuild,
          },
          2
        );
      })
    );
    await f.run(
      resumeRuntimeUpgrade(
        f.repository,
        accepted,
        executorTestPolicy(accepted.plan)
      )
    );
    await f.run(preflightRuntime(f.repository));
    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        expect(catalog.active).not.toBe(revision);
        expect(() => catalog.assertExecutable(revision)).toThrow(oldBuild);
        const refusal = yield* Effect.result(catalog.get(revision));
        expect(refusal._tag).toBe("Failure");
        const manifest = JSON.parse(
          readFileSync(
            path.join(f.state, "revisions", catalog.active, "manifest.json"),
            "utf-8"
          )
        );
        expect(manifest).toMatchObject({ executionContract, format: 3 });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          revisionCatalogLayer(f.repository).pipe(Layer.provide(f.own))
        )
      )
    );
    const reopened = new Database(path.join(f.state, "state.sqlite"));
    try {
      const read = createStore(reopened, {
        assertActive() {
          /* Isolated fixture. */
        },
        token: "fixture",
      });
      const preserved = await Effect.runPromise(read.getRun(run.runId));
      expect(preserved.result).toEqual({
        preserved: true,
      });
      reopened.exec(
        `UPDATE host_runs SET status='Waiting' WHERE runId='${run.runId}'`
      );
    } finally {
      reopened.close();
    }
    await expect(f.run(preflightRuntime(f.repository))).rejects.toMatchObject({
      code: "RevisionUnavailable",
    });
    expect(readFileSync(path.join(directory, "application.mjs"), "utf-8")).toBe(
      application
    );
  } finally {
    db.close();
    f.cleanup();
  }
});

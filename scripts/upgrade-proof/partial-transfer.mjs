/* oxlint-disable no-await-in-loop -- Each real predecessor mutation is tested against its own snapshot. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { Cause, Effect, Exit } from "effect";

import { ownershipLayer } from "../../packages/platform-bun/src/ownership.ts";
import { acceptRuntimeUpgrade } from "../../packages/platform-bun/src/upgrade-executor.ts";
import { makeUpgradeJournal } from "../../packages/platform-bun/src/upgrade-journal.ts";
import { runtimeUpgradePolicy } from "../../packages/platform-bun/src/upgrade-policy.ts";
import { old } from "./process.mjs";

function snapshot(root) {
  const entries = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name.startsWith("state.sqlite.owner") ||
        entry.name.endsWith("-shm")
      ) {
        continue;
      }
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        entries[filename] = "directory";
        walk(filename);
      } else {
        entries[filename] = createHash("sha256")
          .update(readFileSync(filename))
          .digest("hex");
      }
    }
  };
  walk(root);
  return entries;
}

/** Exact target source at a deterministic barrier; predecessor writes and subsequent resume use real binaries. */
export async function partialTransfer(h, requestedRepository, root, plan) {
  const repository = realpathSync(requestedRepository);
  const policy = runtimeUpgradePolicy();
  assert.equal(
    policy.execution.current.build,
    plan.target.build,
    "Compiled target and checkpoint source must have identical ABI"
  );
  const escrow = path.join(root, "partial-transfer-key.json");
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* makeUpgradeJournal(repository);
      const saved = yield* journal.inspect(plan.planId);
      assert.equal(saved._tag, "Planned");
      return yield* acceptRuntimeUpgrade(repository, saved, policy, (name) =>
        name === "credentials-envelope-v2"
          ? Effect.die("proof checkpoint")
          : Effect.void
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ownershipLayer(path.join(repository, ".effectory/state.sqlite.owner"))
      ),
      Effect.exit
    )
  );
  assert.ok(Exit.isFailure(exit));
  assert.match(Cause.pretty(exit.cause), /proof checkpoint/u);
  const credential = JSON.parse(
    readFileSync(path.join(repository, ".effectory/credentials.json"), "utf-8")
  );
  assert.equal(credential.targetBuild, plan.target.build);
  assert.equal(
    JSON.parse(
      readFileSync(
        path.join(repository, ".effectory/runtime-storage.json"),
        "utf-8"
      )
    ).targetBuild,
    plan.source.build
  );
  const results = [];
  for (const args of [
    ["daemon", "serve"],
    ["run", "reclaim", "plan", "--completed-before", "2027-01-01T00:00:00Z"],
    ["run", "reclaim", "inspect", crypto.randomUUID()],
    ["vault", "reset", "credentials", "--discard"],
    ["vault", "key", "import", "credentials", "--file", escrow],
    ["extension", "restore"],
  ]) {
    const before = snapshot(repository);
    const response = await h.raw(old, repository, args);
    assert.notEqual(response.code, 0);
    assert.deepEqual(snapshot(repository), before);
    results.push({ args, error: response.err, exit: response.code });
  }
  return {
    checkpoint: "credentials-envelope-v2",
    results,
    sourceBuild: policy.execution.current.build,
  };
}

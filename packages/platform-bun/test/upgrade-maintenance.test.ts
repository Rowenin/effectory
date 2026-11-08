import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Cause, Effect, Exit, Option } from "effect";

import { emptyLock, lockRevision } from "../src/extension-cache.ts";
import { createExtensionJournal } from "../src/extension-journal.ts";
import { createStore } from "../src/host-store.ts";
import { createLake } from "../src/lake.ts";
import { createRetirementStore } from "../src/run-retirement-store.ts";
import { inspectUpgradeMaintenance } from "../src/upgrade-maintenance.ts";

async function fixture() {
  const directory = mkdtempSync(
    path.join(tmpdir(), "effectory-upgrade-maintenance-")
  );
  mkdirSync(path.join(directory, ".effectory"));
  const database = new Database(":memory:");
  const close = () => {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  };
  try {
    const lease = { assertActive: () => {}, token: "owner" };
    const host = createStore(database, lease);
    createLake(database, path.join(directory, ".effectory/blobs"), lease);
    const journal = createExtensionJournal(database, directory, lease);
    journal.recover();
    const operation = journal.accept(
      {
        expectedRevision: lockRevision(emptyLock),
        kind: "Add",
        requestKey: "add",
        source: {
          assetName: "effectory.tgz",
          ref: "v1",
          repository: "example/example",
        },
        trust: true,
      },
      "owner",
      "a".repeat(64)
    );
    journal.start(operation.operationId, "owner");
    journal.candidate(operation.operationId, "owner", emptyLock);
    journal.begin(operation.operationId, "owner", "b".repeat(64));
    const run = Effect.runSync(
      host.submit(
        { input: {}, kind: "task", requestKey: "run", targetId: "task" },
        "revision",
        "owner"
      )
    );
    Effect.runSync(host.project(run.runId, "Succeeded", {}));
    database.run("UPDATE host_outbox SET delivered=1");
    const retirement = createRetirementStore(database, "repository", "owner");
    await Effect.runPromise(retirement.plan({ runId: run.runId }));
    database
      .query("UPDATE host_retirement_plans SET state='Applying',startedAt=?")
      .run(new Date().toISOString());
    database
      .query("INSERT INTO lake_binary_installs VALUES (?,?,?)")
      .run(`${crypto.randomUUID()}.stage`, "a".repeat(64), 42);
    return { close, database };
  } catch (error) {
    close();
    throw error;
  }
}

test("upgrade inventories pending extension, retirement, and installation records without recovering them", async () => {
  const f = await fixture();
  try {
    const before = f.database.serialize();
    const result = await Effect.runPromise(
      inspectUpgradeMaintenance(f.database)
    );
    expect(result.counts).toEqual({
      activation: 1,
      extensions: 1,
      installs: 1,
      retirement: 1,
    });
    expect(f.database.serialize()).toEqual(before);
    expect(f.database.inTransaction).toBe(false);
  } finally {
    f.close();
  }
});

test.each([
  "UPDATE extension_operations SET status='FutureOperation'",
  "UPDATE extension_operations SET requestJson='{}'",
  "UPDATE extension_activation SET operationId='absent'",
  "UPDATE extension_activation SET afterJson='{}'",
  "UPDATE extension_registry SET revision='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'",
  "DROP TABLE extension_activation",
  "UPDATE host_retirement_plans SET format=2",
  "UPDATE host_retirement_plans SET state='FutureState'",
  "UPDATE host_retirement_plans SET summaryJson='{}'",
  "UPDATE host_retirement_plans SET startedAt=NULL",
  "UPDATE lake_binary_installs SET stage='../escape'",
  "UPDATE lake_binary_installs SET bytes=16777217",
])(
  "upgrade refuses unsupported maintenance without recovery: %s",
  async (fault) => {
    const f = await fixture();
    try {
      f.database.run(fault);
      const before = f.database.serialize();
      const exit = await Effect.runPromiseExit(
        inspectUpgradeMaintenance(f.database)
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && error.value.code).toBe(
          "RevisionUnavailable"
        );
      }
      expect(f.database.serialize()).toEqual(before);
      expect(f.database.inTransaction).toBe(false);
    } finally {
      f.close();
    }
  }
);

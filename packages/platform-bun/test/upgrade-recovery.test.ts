import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { Cause, Effect, Exit, Option } from "effect";

import { createStore } from "../src/host-store.ts";
import { inspectUpgradeRecovery } from "../src/upgrade-recovery.ts";

function fixture() {
  const database = new Database(":memory:");
  const store = createStore(database, {
    assertActive: () => {},
    token: "old-host",
  });
  const run = Effect.runSync(
    store.submit(
      { input: {}, kind: "workflow", requestKey: "submit", targetId: "flow" },
      "revision",
      "owner"
    )
  );
  const admit = (node: string) =>
    Effect.runSync(
      store.admitAttempt(run.runId, node, 1, "manual", { taskVersion: 1 })
    );
  for (const node of ["uncertain", "sibling"]) {
    Effect.runSync(
      store.registerInvocation(run.runId, node, `engine-${node}`, {
        attemptTimeout: null,
        deadline: null,
        input: {},
        nodeId: node,
        permits: [],
        retry: null,
        runId: run.runId,
        taskId: "charge",
      })
    );
  }
  expect(admit("uncertain")).toBe("Admitted");
  expect(admit("uncertain")).toBe("NeedsAttention");
  expect(admit("sibling")).toBe("NeedsAttention");
  let token: string | null = null;
  const authorize = () => {
    const assessment = Effect.runSync(
      store.recoveryGet({ runId: run.runId }, "owner")
    );
    token ??= assessment.token;
    if (token === null) {
      throw new Error("Fixture was not recoverable");
    }
    return Effect.runSync(
      store.recover(
        {
          acknowledgeReexecution: true,
          requestKey: "recover",
          runId: run.runId,
          token,
        },
        "owner"
      )
    );
  };
  return { admit, authorize, database };
}

test("upgrade inspection preserves real holds, authorizations, and gated continuation until consumed", async () => {
  const f = fixture();
  try {
    const held = await Effect.runPromise(inspectUpgradeRecovery(f.database));
    expect(held.counts).toEqual({
      authorizations: 0,
      continuations: 0,
      gates: 1,
      holds: 1,
    });
    const receipt = f.authorize();
    const before = f.database.serialize();
    const pending = await Effect.runPromise(inspectUpgradeRecovery(f.database));
    expect(pending.counts).toEqual({
      authorizations: 1,
      continuations: 1,
      gates: 1,
      holds: 0,
    });
    expect(f.database.serialize()).toEqual(before);
    expect(f.authorize()).toEqual(receipt);
    expect(f.admit("uncertain")).toBe("Admitted");
    expect(f.admit("sibling")).toBe("Admitted");
    const consumed = await Effect.runPromise(
      inspectUpgradeRecovery(f.database)
    );
    expect(consumed.counts).toEqual({
      authorizations: 0,
      continuations: 0,
      gates: 0,
      holds: 0,
    });
    expect(f.database.inTransaction).toBe(false);
  } finally {
    f.database.close();
  }
});

test.each([
  "UPDATE host_recovery_holds SET state='FutureHold'",
  "UPDATE host_recovery_holds SET authorizationId='missing'",
  "UPDATE host_recovery_holds SET entry=99",
  "UPDATE host_recovery_generations SET receiptJson='{}'",
  "UPDATE host_recovery_generations SET acceptedSeq=999999",
  "UPDATE host_recovery_gate_obligations SET generation='missing'",
  "UPDATE host_recovery_gate_obligations SET closed=2",
  "DELETE FROM host_recovery_gates",
  "DELETE FROM host_invocations WHERE nodeId='uncertain'",
  "DROP TABLE host_attempt_windows",
])(
  "upgrade refuses inconsistent recovery records without consuming authorization: %s",
  async (fault) => {
    const f = fixture();
    try {
      f.authorize();
      f.database.run(fault);
      const before = f.database.serialize();
      const exit = await Effect.runPromiseExit(
        inspectUpgradeRecovery(f.database)
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
      f.database.close();
    }
  }
);

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { Effect, Exit, Cause, Option } from "effect";

import { createStore } from "../src/host-store.ts";

function present<A>(value: A | null | undefined): A {
  if (value === null || value === undefined) {
    throw new Error("Missing fixture value");
  }
  return value;
}
function fixture() {
  const database = new Database(":memory:");
  const store = createStore(database, {
    assertActive: () => {},
    token: "owner-lease",
  });
  const run = Effect.runSync(
    store.submit(
      { input: {}, kind: "workflow", requestKey: "submit", targetId: "flow" },
      "revision",
      "owner"
    )
  );
  const register = (node: string) =>
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
  const admit = (node: string) =>
    Effect.runSync(
      store.admitAttempt(run.runId, node, 1, "manual", {
        attemptTimeout: 100_000,
        taskVersion: 1,
      })
    );
  const assess = (limit = 50, cursor?: string) =>
    Effect.runSync(
      store.recoveryGet(
        {
          limit,
          runId: run.runId,
          ...(cursor === undefined ? {} : { cursor }),
        },
        "owner"
      )
    );
  const request = (token: string, requestKey = "recover") => ({
    acknowledgeReexecution: true as const,
    requestKey,
    runId: run.runId,
    token,
  });
  return { admit, assess, database, register, request, run, store };
}
function code<A, E>(effect: Effect.Effect<A, E>) {
  const exit = Effect.runSyncExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = Cause.findErrorOption(exit.cause);
    return Option.isSome(error) &&
      typeof error.value === "object" &&
      error.value !== null
      ? Reflect.get(error.value, "code")
      : undefined;
  }
}

test("all pages are authorized, receipt replay survives completion, and each permission is consumed once", () => {
  const f = fixture();
  try {
    for (const node of ["a", "b"]) {
      f.register(node);
      expect(f.admit(node)).toBe("Admitted");
    }
    expect(f.admit("a")).toBe("NeedsAttention");
    expect(f.admit("b")).toBe("NeedsAttention");
    const first = f.assess(1);
    const second = f.assess(1, present(first.nextCursor));
    expect(first.total).toBe(2);
    expect(first.token).toBe(second.token);
    const request = f.request(present(first.token));
    const receipt = Effect.runSync(f.store.recover(request, "owner"));
    expect(receipt.authorized).toBe(2);
    expect(Effect.runSync(f.store.getRun(f.run.runId)).status).toBe("Running");
    expect(f.admit("a")).toBe("Admitted");
    expect(f.admit("b")).toBe("Admitted");
    expect(f.admit("a")).toBe("NeedsAttention");
    expect(f.assess().entries[0]?.entry).toBe(2);
    expect(
      code(f.store.recover({ ...request, requestKey: "other" }, "owner"))
    ).toBe("Conflict");
    Effect.runSync(f.store.project(f.run.runId, "Succeeded", 42));
    expect(Effect.runSync(f.store.recover(request, "owner", false))).toEqual(
      receipt
    );
    expect(
      code(f.store.recover({ ...request, reason: "changed" }, "owner"))
    ).toBe("Conflict");
    expect(code(f.store.recover(request, "stranger"))).toBe("NotFound");
  } finally {
    f.database.close();
  }
});

test("wait projections preserve holds and late re-gating releases only the old generation", () => {
  const f = fixture();
  try {
    for (const node of ["a", "b", "sibling"]) {
      f.register(node);
    }
    f.admit("a");
    f.admit("b");
    f.admit("a");
    expect(f.admit("sibling")).toBe("NeedsAttention");
    Effect.runSync(f.store.project(f.run.runId, "Running"));
    expect(Effect.runSync(f.store.getRun(f.run.runId)).status).toBe(
      "NeedsAttention"
    );
    const original = f.assess();
    Effect.runSync(
      f.store.recover(f.request(present(original.token)), "owner")
    );
    // late uncertainty: never covered by the earlier token
    f.admit("b");
    // consumes despite the newer hold
    f.admit("a");
    expect(f.assess().state).toBe("Pending");
    // re-gate acknowledges old obligation
    expect(f.admit("sibling")).toBe("NeedsAttention");
    expect(f.assess().state).toBe("Recoverable");
    expect(f.assess().entries.map((row) => row.invocationId)).toEqual([
      "engine-b",
    ]);
    expect(f.assess().latestAuthorization?.continuationPending).toBe(false);
  } finally {
    f.database.close();
  }
});

test("manual re-entry resets only the attempt window and cancellation wins before consumption", () => {
  const f = fixture();
  try {
    f.register("a");
    f.admit("a");
    f.database.query("UPDATE host_attempts SET startedAt=1").run();
    f.database.query("UPDATE host_attempt_windows SET windowStartedAt=1").run();
    expect(f.admit("a")).toBe("NeedsAttention");
    const original = f.assess();
    Effect.runSync(
      f.store.recover(f.request(present(original.token)), "owner")
    );
    const admitted = Effect.runSync(
      f.store.reserveAttempt(f.run.runId, "a", 1, "manual", {
        attemptTimeout: 1000,
      })
    );
    expect(admitted.status).toBe("Admitted");
    expect(admitted.windowStartedAt).toBeGreaterThan(1);
    expect(Effect.runSync(f.store.attemptStartedAt(f.run.runId, "a", 1))).toBe(
      1
    );
    f.store.releaseAttempt(f.run.runId, "a", 1, admitted);
    f.admit("a");
    Effect.runSync(
      f.store.recover(f.request(present(f.assess().token), "second"), "owner")
    );
    Effect.runSync(
      f.store.cancelRequest(
        { requestKey: "cancel", runId: f.run.runId },
        "owner"
      )
    );
    expect(f.admit("a")).toBe("Cancelled");
    Effect.runSync(f.store.recoveryWork());
    expect(f.assess().latestAuthorization?.supersededEntries).toBe(1);
  } finally {
    f.database.close();
  }
});

test("unconsumed permissions and gate obligations survive reopening the store", () => {
  const f = fixture();
  try {
    f.register("a");
    f.register("sibling");
    f.admit("a");
    f.admit("a");
    f.admit("sibling");
    const request = f.request(present(f.assess().token));
    const receipt = Effect.runSync(f.store.recover(request, "owner"));
    const reopened = createStore(f.database, {
      assertActive: () => {},
      token: "new-lease",
    });
    expect(Effect.runSync(reopened.recoveryWork())).toHaveLength(2);
    expect(Effect.runSync(reopened.recover(request, "owner"))).toEqual(receipt);
    expect(
      Effect.runSync(reopened.admitAttempt(f.run.runId, "a", 1, "manual"))
    ).toBe("Admitted");
    expect(
      Effect.runSync(reopened.admitAttempt(f.run.runId, "sibling", 1, "manual"))
    ).toBe("Admitted");
    expect(
      Effect.runSync(reopened.recoveryGet({ runId: f.run.runId }, "owner"))
        .latestAuthorization?.continuationPending
    ).toBe(false);
  } finally {
    f.database.close();
  }
});

test("live target reservations refuse recovery while unrelated siblings remain admitted", () => {
  const f = fixture();
  try {
    f.register("a");
    f.register("sibling");
    const target = Effect.runSync(
      f.store.reserveAttempt(f.run.runId, "a", 1, "manual")
    );
    const sibling = Effect.runSync(
      f.store.reserveAttempt(f.run.runId, "sibling", 1, "idempotent")
    );
    expect(f.admit("a")).toBe("NeedsAttention");
    expect(f.assess().state).toBe("ExecutionActive");
    expect(code(f.store.recover(f.request("stale"), "owner"))).toBe("Conflict");
    f.store.releaseAttempt(f.run.runId, "a", 1, target);
    expect(f.assess().state).toBe("Recoverable");
    Effect.runSync(
      f.store.recover(f.request(present(f.assess().token)), "owner")
    );
    expect(f.admit("a")).toBe("Admitted");
    f.store.releaseAttempt(f.run.runId, "sibling", 1, sibling);
  } finally {
    f.database.close();
  }
});

test("one exhausted attempt refuses the entire set and cancellation remains available", () => {
  const f = fixture();
  try {
    f.register("a");
    f.register("b");
    f.admit("a");
    f.admit("b");
    for (let index = 0; index < 16; index += 1) {
      f.admit("a");
      Effect.runSync(
        f.store.recover(
          f.request(present(f.assess().token), `recover-${index}`),
          "owner"
        )
      );
      expect(f.admit("a")).toBe("Admitted");
    }
    f.admit("a");
    f.admit("b");
    expect(f.assess().state).toBe("AuthorizationLimit");
    expect(f.assess().total).toBe(2);
    expect(f.assess().token).toBeNull();
    expect(code(f.store.recover(f.request("old-token"), "owner"))).toBe(
      "LimitExceeded"
    );
    Effect.runSync(
      f.store.cancelRequest(
        { requestKey: "cancel", runId: f.run.runId },
        "owner"
      )
    );
    expect(f.admit("a")).toBe("Cancelled");
  } finally {
    f.database.close();
  }
});

test("expired absolute deadlines never acquire new permissions and cursors reject changed sets", () => {
  const f = fixture();
  try {
    for (const node of ["a", "b", "c"]) {
      f.register(node);
      f.admit(node);
    }
    f.admit("a");
    f.admit("b");
    const page = f.assess(1);
    f.admit("c");
    expect(
      code(
        f.store.recoveryGet(
          { cursor: present(page.nextCursor), runId: f.run.runId },
          "owner"
        )
      )
    ).toBe("CursorExpired");
    expect(code(f.store.recover(f.request(present(page.token)), "owner"))).toBe(
      "Conflict"
    );
    // Refusal did not reserve the key.
    Effect.runSync(
      f.store.recover(f.request(present(f.assess().token)), "owner")
    );
    f.database.query("UPDATE host_attempt_windows SET deadline=1").run();
    expect(
      Effect.runSync(
        f.store.admitAttempt(f.run.runId, "a", 1, "manual", { deadline: 1 })
      )
    ).toBe("TimedOut");
    expect(f.assess().state).toBe("Stopping");
  } finally {
    f.database.close();
  }
});

test("cancellation closes pending gate obligations after authorization was already consumed", () => {
  const f = fixture();
  try {
    f.register("a");
    f.register("gated");
    f.admit("a");
    f.admit("a");
    expect(f.admit("gated")).toBe("NeedsAttention");
    Effect.runSync(
      f.store.recover(f.request(present(f.assess().token)), "owner")
    );
    expect(f.admit("a")).toBe("Admitted");
    expect(f.assess().latestAuthorization?.continuationPending).toBe(true);
    Effect.runSync(
      f.store.cancelRequest(
        { requestKey: "cancel", runId: f.run.runId },
        "owner"
      )
    );
    expect(Effect.runSync(f.store.recoveryWork())).toEqual([]);
    expect(f.assess().latestAuthorization?.continuationPending).toBe(false);
  } finally {
    f.database.close();
  }
});

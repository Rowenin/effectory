/* Phase barriers poll sequentially; assertions below establish array entries before access. */
/* eslint-disable no-await-in-loop, typescript/no-non-null-assertion, unicorn/no-await-expression-member, require-await */
import { test, expect } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { openEngine } from "@effectory/runtime/engine";
import { SqlRuntimeStore } from "@effectory/runtime/sql-store";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { writeReport } from "../../../.effectory/automations/approved-health-check/action.ts";
import { fixtureTask } from "./engine-fixture.ts";
import { TestStore as RuntimeStore } from "./store-fixture.ts";

const until = async <A>(
  read: () => Promise<A>,
  predicate: (a: A) => boolean
): Promise<A> => {
  const deadline = Date.now() + 15_000;
  while (true) {
    const value = await read();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${JSON.stringify(value)}`);
    }
    await Bun.sleep(50);
  }
};
const workspace = () =>
  mkdtempSync(nodePath.join(tmpdir(), "effectory-engine-"));

test("SQLite engine completes, deduplicates admission, persists artifacts and reopens", async () => {
  const path = workspace();
  let engine = await openEngine({
    tasks: [fixtureTask(path)],
    workspace: path,
  });
  try {
    await expect(
      openEngine({ tasks: [fixtureTask(path)], workspace: path })
    ).rejects.toThrow("already owned");
    const run = await engine.submit({
      input: { approval: false, hold: false },
      requestKey: "one",
      task: "proof",
    });
    await until(
      () => engine.inspectRun(run.id),
      (r) => r.status === "succeeded"
    );
    expect(
      (
        await engine.submit({
          input: { approval: false, hold: false },
          requestKey: "one",
          task: "proof",
        })
      ).id
    ).toBe(run.id);
    await expect(
      engine.submit({
        input: { approval: true, hold: false },
        requestKey: "one",
        task: "proof",
      })
    ).rejects.toThrow("conflicts");
    expect((await engine.listArtifacts(run.id)).length).toBe(1);
    await engine.close();
    engine = await openEngine({ tasks: [fixtureTask(path)], workspace: path });
    expect((await engine.inspectRun(run.id)).status).toBe("succeeded");
    expect(
      (await engine.getArtifact((await engine.listArtifacts(run.id))[0]!.id))
        .value
    ).toEqual({ first: "committed", runId: run.id });
    expect(
      readFileSync(nodePath.join(path, "first.log"), "utf-8").trim().split("\n")
    ).toHaveLength(1);
  } finally {
    await engine.close();
    rmSync(path, { force: true, recursive: true });
  }
}, 25_000);

test("SIGKILL after committed activity reclaims owner and replays only unfinished activity", async () => {
  const path = workspace();
  const child = Bun.spawn(
    [process.execPath, `${import.meta.dir}/engine-fixture.ts`, path],
    { stderr: "pipe", stdout: "pipe" }
  );
  try {
    await until(
      async () => existsSync(nodePath.join(path, "barrier.log")),
      Boolean
    );
    child.kill("SIGKILL");
    await child.exited;
    writeFileSync(nodePath.join(path, "release"), "go");
    const engine = await openEngine({
      tasks: [fixtureTask(path)],
      workspace: path,
    });
    try {
      const runs = await engine.listRuns();
      expect(runs).toHaveLength(1);
      const done = await until(
        () => engine.inspectRun(runs[0]!.id),
        (r) => r.status === "succeeded"
      );
      expect(done.result).toBe("committed");
      expect(
        readFileSync(nodePath.join(path, "first.log"), "utf-8")
          .trim()
          .split("\n")
      ).toHaveLength(1);
    } finally {
      await engine.close();
    }
  } finally {
    child.kill();
    await child.exited;
    rmSync(path, { force: true, recursive: true });
  }
}, 25_000);

test("durable approval survives shutdown, validates review and requires explicit resume", async () => {
  const path = workspace();
  let engine = await openEngine({
    tasks: [fixtureTask(path)],
    workspace: path,
  });
  try {
    const run = await engine.submit({
      input: { approval: true, hold: false },
      requestKey: "approve",
      task: "proof",
    });
    const [approval] = await until(
      () => engine.listApprovals(),
      (a) => a.length === 1
    );
    await until(
      () => engine.inspectRun(run.id),
      (r) => r.status === "suspended"
    );
    await engine.close();
    engine = await openEngine({ tasks: [fixtureTask(path)], workspace: path });
    const decision = {
      digest: approval!.digest,
      id: approval!.id,
      outcome: "approved" as const,
      revision: approval!.revision,
    };
    await expect(
      engine.decideApproval({ ...decision, digest: "stale" })
    ).rejects.toThrow("Stale");
    await engine.decideApproval(decision);
    await engine.decideApproval(decision);
    await engine.close();
    engine = await openEngine({ tasks: [fixtureTask(path)], workspace: path });
    expect((await engine.inspectApproval(approval!.id)).delivered).toBe(false);
    expect(existsSync(nodePath.join(path, `${run.id}.json`))).toBe(false);
    await engine.resumeRun(run.id);
    await expect(
      engine.decideApproval({ ...decision, outcome: "rejected" })
    ).rejects.toThrow(/conflicting/iu);
    await until(
      () => engine.inspectRun(run.id),
      (r) => r.status === "succeeded"
    );
    expect(existsSync(nodePath.join(path, `${run.id}.json`))).toBe(true);
    expect(
      readFileSync(nodePath.join(path, "first.log"), "utf-8").trim().split("\n")
    ).toHaveLength(1);
  } finally {
    await engine.close();
    rmSync(path, { force: true, recursive: true });
  }
}, 25_000);

test("rejection and cancellation prevent the approved action", async () => {
  for (const outcome of ["rejected", "cancelled"] as const) {
    const path = workspace();
    const engine = await openEngine({
      tasks: [fixtureTask(path)],
      workspace: path,
    });
    try {
      const run = await engine.submit({
        input: { approval: true, hold: false },
        requestKey: outcome,
        task: "proof",
      });
      const [a] = await until(
        () => engine.listApprovals(),
        (v) => v.length === 1
      );
      if (outcome === "rejected") {
        await engine.decideApproval({
          digest: a!.digest,
          id: a!.id,
          outcome,
          revision: a!.revision,
        });
        await until(
          () => engine.inspectRun(run.id),
          (r) => r.status === "failed"
        );
      } else {
        await engine.cancelRun(run.id);
        await until(
          () => engine.inspectRun(run.id),
          (r) => r.status === "cancelled"
        );
        await expect(
          engine.decideApproval({
            digest: a!.digest,
            id: a!.id,
            outcome: "approved",
            revision: a!.revision,
          })
        ).rejects.toThrow("cancelled");
      }
      expect(existsSync(nodePath.join(path, `${run.id}.json`))).toBe(false);
    } finally {
      await engine.close();
      rmSync(path, { force: true, recursive: true });
    }
  }
}, 25_000);

test("bounded immutable artifacts and idempotent file action reject conflicts", async () => {
  const path = workspace();
  const store = new RuntimeStore(path);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* checkArtifacts() {
          const sql = yield* SqlClient.SqlClient;
          const live = new SqlRuntimeStore(sql);
          yield* live.publish("run", "result", { ok: true });
          const conflict = yield* Effect.flip(
            Effect.sandbox(live.publish("run", "result", { ok: false }))
          );
          expect(String(conflict)).toContain("conflict");
          const oversized = yield* Effect.flip(
            Effect.sandbox(live.publish("run", "huge", "x".repeat(256 * 1024)))
          );
          expect(String(oversized)).toContain("exceeds");
        }).pipe(
          Effect.provide(SqliteClient.layer({ filename: store.filename }))
        )
      )
    );
    const action = nodePath.join(path, "action.json");
    await Effect.runPromise(writeReport(action, { ok: true }));
    await Effect.runPromise(writeReport(action, { ok: true }));
    await expect(
      Effect.runPromise(writeReport(action, { ok: false }))
    ).rejects.toThrow(/conflicting/iu);
  } finally {
    store.close();
    rmSync(path, { force: true, recursive: true });
  }
});

test("admission gap and completion index gap reconcile against the native engine", async () => {
  const path = workspace();
  const now = new Date().toISOString();
  const store = new RuntimeStore(path);
  store.putRun({
    createdAt: now,
    id: "admitted-before-engine-dispatch",
    input: { approval: false, hold: false },
    requestKey: "admission-gap",
    revision: "proof-v1",
    status: "admitted",
    task: "proof",
    updatedAt: now,
  });
  store.close();
  let engine = await openEngine({
    tasks: [fixtureTask(path)],
    workspace: path,
  });
  try {
    await until(
      () => engine.inspectRun("admitted-before-engine-dispatch"),
      (r) => r.status === "succeeded"
    );
    await engine.close();
    const stale = new RuntimeStore(path);
    const run = stale.requireRun("admitted-before-engine-dispatch");
    stale.putRun({ ...run, status: "running" });
    stale.close();
    engine = await openEngine({ tasks: [fixtureTask(path)], workspace: path });
    expect((await engine.inspectRun(run.id)).status).toBe("succeeded");
    expect(
      readFileSync(nodePath.join(path, "first.log"), "utf-8").trim().split("\n")
    ).toHaveLength(1);
  } finally {
    await engine.close();
    rmSync(path, { force: true, recursive: true });
  }
}, 25_000);

test("resume committed before deferred delivery is recovered from the outbox", async () => {
  const path = workspace();
  let engine = await openEngine({
    tasks: [fixtureTask(path)],
    workspace: path,
  });
  try {
    const run = await engine.submit({
      input: { approval: true, hold: false },
      requestKey: "decision-gap",
      task: "proof",
    });
    const [a] = await until(
      () => engine.listApprovals(),
      (v) => v.length === 1
    );
    await engine.close();
    const store = new RuntimeStore(path);
    store.putApproval({
      ...a!,
      decision: {
        decidedAt: new Date().toISOString(),
        operator: "local-user",
        outcome: "approved",
      },
      delivered: false,
      released: true,
      status: "approved",
    });
    store.close();
    engine = await openEngine({ tasks: [fixtureTask(path)], workspace: path });
    await until(
      () => engine.inspectRun(run.id),
      (r) => r.status === "succeeded"
    );
    expect((await engine.inspectApproval(a!.id)).delivered).toBe(true);
    expect(existsSync(nodePath.join(path, `${run.id}.json`))).toBe(true);
  } finally {
    await engine.close();
    rmSync(path, { force: true, recursive: true });
  }
}, 25_000);

test("graceful shutdown preserves active work and refuses an incompatible unfinished revision", async () => {
  const path = workspace();
  let engine = await openEngine({
    tasks: [fixtureTask(path)],
    workspace: path,
  });
  try {
    const run = await engine.submit({
      input: { approval: false, hold: true },
      requestKey: "graceful",
      task: "proof",
    });
    await until(
      async () => existsSync(nodePath.join(path, "barrier.log")),
      Boolean
    );
    await engine.close();
    const changed = {
      ...fixtureTask(path),
      fingerprint: { digest: "proof-v2", files: [] },
    };
    await expect(
      openEngine({ tasks: [changed], workspace: path })
    ).rejects.toThrow("requires task");
    writeFileSync(nodePath.join(path, "release"), "go");
    engine = await openEngine({ tasks: [fixtureTask(path)], workspace: path });
    await until(
      () => engine.inspectRun(run.id),
      (r) => r.status === "succeeded"
    );
    expect(
      readFileSync(nodePath.join(path, "first.log"), "utf-8").trim().split("\n")
    ).toHaveLength(1);
  } finally {
    await engine.close();
    rmSync(path, { force: true, recursive: true });
  }
}, 25_000);

test("SIGKILL after local action reconciles the existing file before completing activity", async () => {
  const path = workspace();
  const child = Bun.spawn(
    [process.execPath, `${import.meta.dir}/engine-fixture.ts`, path],
    {
      env: { ...process.env, EFFECTORY_ENGINE_PROOF_HOLD_ACTION: "1" },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  try {
    await until(
      async () => existsSync(nodePath.join(path, "action.log")),
      Boolean
    );
    const id = readFileSync(nodePath.join(path, "action.log"), "utf-8").trim();
    const file = Bun.file(nodePath.join(path, `${id}.json`));
    const original = await file.text();
    const modified = file.lastModified;
    child.kill("SIGKILL");
    await child.exited;
    const engine = await openEngine({
      tasks: [fixtureTask(path)],
      workspace: path,
    });
    try {
      await until(
        () => engine.inspectRun(id),
        (r) => r.status === "succeeded"
      );
      expect(await Bun.file(nodePath.join(path, `${id}.json`)).text()).toBe(
        original
      );
      expect(Bun.file(nodePath.join(path, `${id}.json`)).lastModified).toBe(
        modified
      );
      expect(
        readFileSync(nodePath.join(path, "first.log"), "utf-8")
          .trim()
          .split("\n")
      ).toHaveLength(1);
    } finally {
      await engine.close();
    }
  } finally {
    child.kill();
    await child.exited;
    rmSync(path, { force: true, recursive: true });
  }
}, 25_000);

test("cancellation persisted before native dispatch produces native interruption without executing user code", async () => {
  const path = workspace();
  const now = new Date().toISOString();
  const store = new RuntimeStore(path);
  store.putRun({
    createdAt: now,
    id: "cancelled-before-dispatch",
    input: { approval: false, hold: false },
    requestKey: "cancel-gap",
    revision: "proof-v1",
    status: "cancelling",
    task: "proof",
    updatedAt: now,
  });
  store.close();
  const engine = await openEngine({
    tasks: [fixtureTask(path)],
    workspace: path,
  });
  try {
    await until(
      () => engine.inspectRun("cancelled-before-dispatch"),
      (r) => r.status === "cancelled"
    );
    expect(existsSync(nodePath.join(path, "first.log"))).toBe(false);
    expect(
      existsSync(nodePath.join(path, "cancelled-before-dispatch.json"))
    ).toBe(false);
  } finally {
    await engine.close();
    rmSync(path, { force: true, recursive: true });
  }
}, 25_000);

test("concurrent identical and conflicting approval decisions are arbitrated atomically", async () => {
  const path = workspace();
  const engine = await openEngine({
    tasks: [fixtureTask(path)],
    workspace: path,
  });
  try {
    const run = await engine.submit({
      input: { approval: true, hold: false },
      requestKey: "decision-race",
      task: "proof",
    });
    const [a] = await until(
      () => engine.listApprovals(),
      (v) => v.length === 1
    );
    const decision = {
      digest: a!.digest,
      id: a!.id,
      outcome: "approved" as const,
      revision: a!.revision,
    };
    const results = await Promise.allSettled([
      engine.decideApproval(decision),
      engine.decideApproval(decision),
      engine.decideApproval({ ...decision, outcome: "rejected" }),
    ]);
    expect(results[0]!.status).toBe("fulfilled");
    expect(results[1]!.status).toBe("fulfilled");
    expect(results[2]!.status).toBe("rejected");
    await engine.resumeRun(run.id);
    await until(
      () => engine.inspectRun(run.id),
      (r) => r.status === "succeeded"
    );
    expect((await engine.inspectApproval(a!.id)).decision?.outcome).toBe(
      "approved"
    );
  } finally {
    await engine.close();
    rmSync(path, { force: true, recursive: true });
  }
}, 25_000);

test("ownership detects PID reuse and old cleanup cannot release a replacement owner", async () => {
  const path = workspace();
  const { claimWorkspace } = await import("@effectory/runtime/host");
  const store = new RuntimeStore(path);
  try {
    const releaseOld = claimWorkspace(store);
    store.db
      .query("UPDATE effectory_owner SET identity=? WHERE id=1")
      .run("earlier-process-start");
    const releaseNew = claimWorkspace(store);
    releaseOld();
    expect(() => claimWorkspace(store)).toThrow("already owned");
    releaseNew();
    const releaseFinal = claimWorkspace(store);
    releaseFinal();
  } finally {
    store.close();
    rmSync(path, { force: true, recursive: true });
  }
});

test("malformed input never admits and new request keys produce independent executions", async () => {
  const path = workspace();
  const engine = await openEngine({
    tasks: [fixtureTask(path)],
    workspace: path,
  });
  try {
    await expect(
      engine.submit({
        input: { approval: "wrong" },
        requestKey: "invalid",
        task: "proof",
      })
    ).rejects.toThrow();
    expect(await engine.listRuns()).toHaveLength(0);
    const [one, duplicate, two] = await Promise.all([
      engine.submit({
        input: { approval: false, hold: false },
        requestKey: "new-one",
        task: "proof",
      }),
      engine.submit({
        input: { approval: false, hold: false },
        requestKey: "new-one",
        task: "proof",
      }),
      engine.submit({
        input: { approval: false, hold: false },
        requestKey: "new-two",
        task: "proof",
      }),
    ]);
    expect(duplicate!.id).toBe(one!.id);
    expect(two!.id).not.toBe(one!.id);
    await until(
      () => engine.listRuns(),
      (runs) => runs.length === 2 && runs.every((r) => r.status === "succeeded")
    );
    expect(await engine.listArtifacts()).toHaveLength(2);
    expect(
      readFileSync(nodePath.join(path, "first.log"), "utf-8").trim().split("\n")
    ).toHaveLength(2);
  } finally {
    await engine.close();
    rmSync(path, { force: true, recursive: true });
  }
}, 25_000);

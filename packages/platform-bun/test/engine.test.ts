/* oxlint-disable no-await-in-loop */
// Readiness polling is bounded and depends on each preceding filesystem read.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Layer, Schema } from "effect";

import { ownershipLayer, RepositoryLease } from "../src/ownership.ts";

const Result = Schema.Struct({
  duplicate: Schema.String,
  id: Schema.String,
  result: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
});

async function waitForFile(filename: string) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await Bun.file(filename).exists()) {
      const text = await Bun.file(filename).text();
      if (text.length > 0) {
        return Schema.decodeUnknownSync(Result)(JSON.parse(text));
      }
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

test("engine results and host wait decisions survive death before notification", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-engine-"));
  const database = path.join(directory, "state.sqlite");
  const startFile = path.join(directory, "started.json");
  const decisionFile = path.join(directory, "decision.json");
  const finishFile = path.join(directory, "finished.json");
  const script = path.join(import.meta.dir, "fixtures/engine-process.ts");
  const first = Bun.spawn(
    [process.execPath, script, database, "start", startFile],
    { stderr: "pipe", stdout: "pipe" }
  );
  let second: ReturnType<typeof Bun.spawn> | undefined;
  let decision: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const start = await waitForFile(startFile);
    expect(start.id).toBe(start.duplicate);
    first.kill("SIGKILL");
    await first.exited;
    decision = Bun.spawn(
      [process.execPath, script, database, "record-answer", decisionFile],
      { stderr: "pipe", stdout: "pipe" }
    );
    const recorded = await waitForFile(decisionFile);
    expect(recorded.status).toBe("Recorded");
    decision.kill("SIGKILL");
    await decision.exited;
    second = Bun.spawn(
      [process.execPath, script, database, "finish", finishFile],
      { stderr: "pipe", stdout: "pipe" }
    );
    const finish = await waitForFile(finishFile);
    expect(finish.id).toBe(start.id);
    expect(finish.result).toBe("recorded:approved");
    expect(await second.exited).toBe(0);
    const audit = new Database(`${database}.audit`);
    try {
      expect(
        audit.query("SELECT count FROM effects WHERE id = 'first'").get()
      ).toEqual({ count: 1 });
    } finally {
      audit.close();
    }
  } catch (error) {
    first.kill();
    decision?.kill();
    second?.kill();
    const diagnostics = await new Response(first.stderr).text();
    throw new Error(`${String(error)}\n${diagnostics}`, { cause: error });
  } finally {
    first.kill();
    decision?.kill();
    second?.kill();
    await Promise.all([first.exited, decision?.exited, second?.exited]);
    await rm(directory, { force: true, recursive: true });
  }
}, 25_000);

async function manualRecovery(mode: "manual-start" | "manual-drain") {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-manual-"));
  const database = path.join(directory, "state.sqlite");
  const firstFile = path.join(directory, "first.json");
  const recoveredFile = path.join(directory, "recovered.json");
  const script = path.join(import.meta.dir, "fixtures/engine-process.ts");
  const first = Bun.spawn(
    [process.execPath, script, database, mode, firstFile],
    { stderr: "pipe", stdout: "pipe" }
  );
  let second: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const firstResult = await waitForFile(firstFile);
    expect(firstResult.status).toBe("InFlight");
    if (mode === "manual-start") {
      first.kill("SIGKILL");
    }
    await first.exited;
    second = Bun.spawn(
      [process.execPath, script, database, "manual-recover", recoveredFile],
      { stderr: "pipe", stdout: "pipe" }
    );
    const recovered = await waitForFile(recoveredFile);
    expect(recovered.status).toBe("NeedsAttention");
    expect(await second.exited).toBe(0);
    const audit = new Database(`${database}.audit`);
    try {
      expect(
        audit.query("SELECT count FROM effects WHERE id = 'manual'").get()
      ).toEqual({ count: 1 });
    } finally {
      audit.close();
    }
  } finally {
    first.kill();
    second?.kill();
    await Promise.all([first.exited, second?.exited]);
    await rm(directory, { force: true, recursive: true });
  }
}

test(
  "an uncertain manual activity suspends after process death",
  () => manualRecovery("manual-start"),
  25_000
);
test(
  "an uncertain manual activity suspends after graceful engine shutdown",
  () => manualRecovery("manual-drain"),
  25_000
);

test("repository ownership excludes a second host and fences a released lease", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-owner-"));
  const filename = path.join(directory, "owner.sqlite");
  try {
    const lease = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(ownershipLayer(filename));
          const current = yield* RepositoryLease.pipe(
            Effect.provideContext(context)
          );
          current.assertActive();
          const concurrent = yield* Effect.exit(
            Effect.scoped(Layer.build(ownershipLayer(filename)))
          );
          expect(concurrent._tag).toBe("Failure");
          return current;
        })
      )
    );
    expect(() => lease.assertActive()).toThrow("ownership has ended");
    await Effect.runPromise(
      Effect.scoped(Layer.build(ownershipLayer(filename)))
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

async function recoverTimer(mode: "finish" | "cancel") {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-timer-"));
  const database = path.join(directory, "state.sqlite");
  const started = path.join(directory, "started.json");
  const finished = path.join(directory, "finished.json");
  const script = path.join(import.meta.dir, "fixtures/timer-process.ts");
  const first = Bun.spawn(
    [process.execPath, script, database, "start", started],
    { stderr: "pipe", stdout: "pipe" }
  );
  let second: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const initial = await waitForFile(started);
    expect(initial.status).toBe("Suspended");
    first.kill("SIGKILL");
    await first.exited;
    // Let the original deadline pass with no daemon alive.
    if (mode === "finish") {
      await Bun.sleep(3100);
    }
    second = Bun.spawn([process.execPath, script, database, mode, finished], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const result = await waitForFile(finished);
    expect(result.id).toBe(initial.id);
    expect(result.status).toBe(mode === "finish" ? "Succeeded" : "Cancelled");
    expect(await second.exited).toBe(0);
  } finally {
    first.kill();
    second?.kill();
    await Promise.all([first.exited, second?.exited]);
    await rm(directory, { force: true, recursive: true });
  }
}

test(
  "a short durable timer survives a deadline elapsed while offline",
  () => recoverTimer("finish"),
  25_000
);
test(
  "cancellation settles a suspended engine execution",
  () => recoverTimer("cancel"),
  25_000
);

test("accepted work survives death before dispatch and competing processes cannot enter", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-dispatch-"));
  const database = path.join(directory, "state.sqlite");
  const acceptedFile = path.join(directory, "accepted.json");
  const startedFile = path.join(directory, "started.json");
  const script = path.join(import.meta.dir, "fixtures/engine-process.ts");
  const first = Bun.spawn(
    [process.execPath, script, database, "accept-only", acceptedFile],
    { stderr: "pipe", stdout: "pipe" }
  );
  let second: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const accepted = await waitForFile(acceptedFile);
    expect(accepted.status).toBe("Queued");
    const competitor = Bun.spawn(
      [process.execPath, script, database, "start", startedFile],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(await competitor.exited).not.toBe(0);
    expect(await new Response(competitor.stderr).text()).toContain(
      "RepositoryBusy"
    );
    first.kill("SIGKILL");
    await first.exited;
    second = Bun.spawn(
      [process.execPath, script, database, "start", startedFile],
      { stderr: "pipe", stdout: "pipe" }
    );
    const started = await waitForFile(startedFile);
    const store = new Database(database, { readonly: true });
    try {
      expect(
        store.query("SELECT runId, engineId FROM host_runs").all()
      ).toEqual([{ engineId: started.id, runId: accepted.id }]);
      expect(
        store
          .query("SELECT delivered FROM host_outbox WHERE kind = 'Dispatch'")
          .all()
      ).toEqual([{ delivered: 1 }]);
    } finally {
      store.close();
    }
  } finally {
    first.kill();
    second?.kill();
    await Promise.all([first.exited, second?.exited]);
    await rm(directory, { force: true, recursive: true });
  }
}, 25_000);

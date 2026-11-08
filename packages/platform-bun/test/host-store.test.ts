import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { OperationError } from "@effectory/runtime/protocol";
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";

import type { createStore } from "../src/host-store.ts";
import { HostStore, hostStoreLayer } from "../src/host-store.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { createRunWatcher } from "../src/run-watch.ts";

async function withStore<A>(
  program: (
    store: ReturnType<typeof createStore>
  ) => Effect.Effect<A, OperationError>
) {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-store-"));
  try {
    const layer = hostStoreLayer(path.join(directory, "state.sqlite")).pipe(
      Layer.provide(ownershipLayer(path.join(directory, "owner.sqlite")))
    );
    return await Effect.runPromise(
      Effect.flatMap(HostStore, program).pipe(Effect.provide(layer))
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

const submission = {
  input: { name: "Ada" },
  kind: "workflow",
  requestKey: "submit-1",
  targetId: "welcome",
} as const;
const validateString = (value: Schema.Json) =>
  Schema.decodeUnknownSync(Schema.String)(value);

test("acceptance commits one dispatch intent and retries retain the original revision", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const first = yield* store.submit(submission, "revision-one", "owner");
      const second = yield* store.submit(submission, "revision-two", "owner");
      expect(second.runId).toBe(first.runId);
      expect(second.revision).toBe("revision-one");
      expect(yield* store.outbox()).toHaveLength(1);
      const conflict = yield* Effect.exit(
        store.submit(
          { ...submission, input: { name: "Grace" } },
          "revision-two",
          "owner"
        )
      );
      expect(Exit.isFailure(conflict)).toBe(true);
      expect(yield* store.listRuns()).toHaveLength(1);
    })
  ));

test("wait answers validate before commit, have stable receipts and queue continuation once", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      const wait = yield* store.openWait({
        context: null,
        deadline: Date.now() + 10_000,
        kind: "input",
        nodeId: "destination",
        runId: run.runId,
      });
      const invalid = yield* Effect.exit(
        store.settle(
          {
            input: 123,
            operation: "respond",
            requestKey: "answer",
            waitId: wait.waitId,
          },
          "owner",
          validateString
        )
      );
      expect(Exit.isFailure(invalid)).toBe(true);
      expect((yield* store.getWait(wait.waitId)).status).toBe("Open");
      const request = {
        input: "staging",
        operation: "respond",
        requestKey: "answer",
        waitId: wait.waitId,
      } as const;
      const first = yield* store.settle(request, "owner", validateString);
      const second = yield* store.settle(request, "owner", validateString);
      expect(second).toEqual(first);
      expect((yield* store.getWait(wait.waitId)).payload).toBe("staging");
      expect(
        (yield* store.outbox()).filter((item) => item.kind === "Settle")
      ).toHaveLength(1);
      const conflict = yield* Effect.exit(
        store.settle(
          { ...request, input: "production" },
          "owner",
          validateString
        )
      );
      expect(Exit.isFailure(conflict)).toBe(true);
      const anotherActor = yield* Effect.exit(
        store.settle(request, "different-owner", validateString)
      );
      expect(Exit.isFailure(anotherActor)).toBe(true);
    })
  ));

test("delivery enforces expiry and commits timeout even when delivery returns an error", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      const wait = yield* store.openWait({
        context: null,
        deadline: Date.now() - 1,
        kind: "signal",
        nodeId: "callback",
        runId: run.runId,
      });
      const response = yield* Effect.exit(
        store.settle(
          {
            input: "late",
            operation: "signal",
            requestKey: "answer",
            waitId: wait.waitId,
          },
          "owner",
          validateString
        )
      );
      expect(Exit.isFailure(response)).toBe(true);
      expect((yield* store.getWait(wait.waitId)).status).toBe("TimedOut");
      expect(
        (yield* store.outbox()).some((item) => item.kind === "Settle")
      ).toBe(true);
    })
  ));

test("cancel closes open waits and a late answer cannot revive them", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      const wait = yield* store.openWait({
        context: null,
        deadline: Date.now() + 10_000,
        kind: "approval",
        nodeId: "review",
        runId: run.runId,
      });
      const wrongKind = yield* Effect.exit(
        store.settle(
          {
            input: "wrong",
            operation: "respond",
            requestKey: "answer",
            waitId: wait.waitId,
          },
          "owner",
          validateString
        )
      );
      expect(Exit.isFailure(wrongKind)).toBe(true);
      yield* store.cancel(run.runId);
      const late = yield* Effect.exit(
        store.settle(
          { operation: "approve", requestKey: "approval", waitId: wait.waitId },
          "owner",
          validateString
        )
      );
      expect(Exit.isFailure(late)).toBe(true);
      expect((yield* store.getWait(wait.waitId)).status).toBe("Cancelled");
      expect((yield* store.getRun(run.runId)).status).toBe("Cancelling");
    })
  ));

test("attempt admission holds uncertain manual work but permits idempotent recovery", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      expect(yield* store.admitAttempt(run.runId, "manual", 1, "manual")).toBe(
        "Admitted"
      );
      expect(yield* store.admitAttempt(run.runId, "manual", 1, "manual")).toBe(
        "NeedsAttention"
      );
      expect((yield* store.getRun(run.runId)).status).toBe("NeedsAttention");
      expect(
        yield* store.admitAttempt(run.runId, "safe", 1, "idempotent")
      ).toBe("NeedsAttention");
      const safeRun = yield* store.submit(
        { ...submission, requestKey: "safe-run" },
        "revision",
        "owner"
      );
      expect(
        yield* store.admitAttempt(safeRun.runId, "safe", 1, "idempotent")
      ).toBe("Admitted");
      expect(
        yield* store.admitAttempt(safeRun.runId, "safe", 1, "idempotent")
      ).toBe("Admitted");
    })
  ));

test("stale live projections cannot overwrite cancellation or stalled finalization", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      yield* store.project(run.runId, "Running");
      yield* store.cancelRequest(
        { requestKey: "stop", runId: run.runId },
        "owner"
      );
      for (const stoppedStatus of ["Cancelling", "NeedsAttention"] as const) {
        if (stoppedStatus === "NeedsAttention") {
          yield* store.project(run.runId, stoppedStatus);
        }
        const before = yield* store.getRun(run.runId);
        expect(before.status).toBe(stoppedStatus);
        for (const staleStatus of [
          "Queued",
          "Running",
          "Waiting",
          "Retrying",
        ] as const) {
          expect(yield* store.project(run.runId, staleStatus)).toEqual(before);
        }
        expect(yield* store.getRun(run.runId)).toEqual(before);
      }
      expect((yield* store.project(run.runId, "Cancelled")).status).toBe(
        "Cancelled"
      );
    })
  ));

test("a stop fence protects live projection even before its status is reconciled", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      yield* store.project(run.runId, "Waiting");
      const reason = {
        _tag: "ExecutionFailure",
        category: "Control",
        detail: { deadline: 1 },
        outcome: "TimedOut",
      };
      yield* store.fence(run.runId, reason);
      const before = yield* store.getRun(run.runId);
      expect(yield* store.project(run.runId, "Running")).toEqual(before);
      expect(yield* store.fenceReason(run.runId)).toEqual(reason);
      expect(
        (yield* store.project(run.runId, "TimedOut", reason.detail, "Control"))
          .status
      ).toBe("TimedOut");
    })
  ));

test("repeated terminal projections do not duplicate events or rewrite success", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      yield* store.project(run.runId, "Succeeded", "done");
      yield* store.project(run.runId, "Succeeded", "done");
      yield* store.cancel(run.runId);
      expect(
        (yield* store.events(run.runId)).map((event) => event.tag)
      ).toEqual(["RunAccepted", "RunStatus"]);
      expect((yield* store.getRun(run.runId)).result).toBe("done");
    })
  ));

test("cancellation receipts retain the original request, enforce actor scope, and bound duplicate history", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      const request = {
        reason: "Stopped by operator",
        requestKey: "cancel",
        runId: run.runId,
      };
      expect(
        (yield* Effect.result(store.cancelRequest(request, "other")))._tag
      ).toBe("Failure");
      expect((yield* store.getRun(run.runId)).status).toBe("Queued");
      const first = yield* store.cancelRequest(request, "owner");
      expect(first.status).toBe("Cancelling");
      yield* store.project(run.runId, "Cancelled");
      expect(yield* store.cancelRequest(request, "owner")).toEqual(first);
      const changed = yield* Effect.result(
        store.cancelRequest({ ...request, reason: "Different input" }, "owner")
      );
      expect(changed._tag).toBe("Failure");
      if (changed._tag === "Failure") {
        expect(changed.failure.code).toBe("Conflict");
      }
      for (let index = 1; index < 64; index += 1) {
        const receipt = yield* store.cancelRequest(
          { ...request, requestKey: `cancel-${index}` },
          "owner"
        );
        expect(receipt.status).toBe("Cancelled");
      }
      const limited = yield* Effect.result(
        store.cancelRequest({ ...request, requestKey: "overflow" }, "owner")
      );
      expect(limited._tag).toBe("Failure");
      if (limited._tag === "Failure") {
        expect(limited.failure.code).toBe("LimitExceeded");
      }
      expect(yield* store.cancelRequest(request, "owner")).toEqual(first);
      expect(
        (yield* store.events(run.runId)).filter(
          (item) => item.tag === "CancellationRequested"
        )
      ).toHaveLength(1);
    })
  ));

test("run history pages exclude new admissions, bind filters/principals and expose current projections", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const initial = [];
      for (let index = 0; index < 4; index += 1) {
        initial.push(
          yield* store.submit(
            { ...submission, requestKey: `history-${index}` },
            "revision",
            "owner"
          )
        );
      }
      yield* store.submit(
        { ...submission, requestKey: "hidden" },
        "revision",
        "other"
      );
      const page = yield* store.history({ limit: 2 }, "owner");
      expect(page.items).toHaveLength(2);
      expect(page.cursor).not.toBeNull();
      const late = yield* store.submit(
        { ...submission, requestKey: "late" },
        "revision",
        "owner"
      );
      if (page.cursor === null) {
        return yield* Effect.die("Expected history cursor");
      }
      const next = yield* store.history(
        { cursor: page.cursor, limit: 2 },
        "owner"
      );
      expect(next.snapshot).toBe(page.snapshot);
      expect(next.cursor).toBeNull();
      expect(
        [...page.items, ...next.items].map((item) => item.runId).toSorted()
      ).toEqual(initial.map((item) => item.runId).toSorted());
      expect(next.items.some((item) => item.runId === late.runId)).toBe(false);
      expect(
        (yield* Effect.result(
          store.history({ cursor: page.cursor, limit: 2 }, "other")
        ))._tag
      ).toBe("Failure");
      expect(
        (yield* Effect.result(
          store.history(
            { cursor: page.cursor, limit: 2, targetId: "changed" },
            "owner"
          )
        ))._tag
      ).toBe("Failure");
      yield* store.project(late.runId, "Succeeded", { privateResult: true });
      const completed = yield* store.history({ status: "Succeeded" }, "owner");
      expect(completed.items.map((item) => item.runId)).toEqual([late.runId]);
      expect(Object.hasOwn(completed.items[0] ?? {}, "result")).toBe(false);
      expect((yield* store.history({}, "other")).items).toHaveLength(1);
    })
  ));

test("watch hands off a live snapshot to terminal history without gaps and resumes by event sequence", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      const watcher = createRunWatcher(store);
      let finished = false;
      const frames = yield* watcher.watch(run.runId, "owner").pipe(
        Stream.tap((frame) =>
          Effect.gen(function* () {
            if (frame._tag !== "Snapshot" || finished) {
              return;
            }
            finished = true;
            // Commit while the observer consumes its initial snapshot. The final
            // event sits beyond two replay batches and must still be delivered.
            for (let index = 0; index < 40; index += 1) {
              yield* store.appendEvent(
                run.runId,
                `progress-${index}`,
                "Progress",
                { index }
              );
            }
            yield* store.project(run.runId, "Succeeded", null);
          })
        ),
        Stream.runCollect
      );
      const events = frames
        .filter((frame) => frame._tag === "Event")
        .map((frame) => frame.event);
      const final = yield* store.getRun(run.runId);
      expect(events.map((event) => event.sequence)).toEqual(
        Array.from({ length: final.lastSequence }, (_, index) => index + 1)
      );
      expect(events.at(-1)?.payload).toEqual({ status: "Succeeded" });
      expect(watcher.active).toBe(0);
      const resumed = yield* watcher
        .watch(run.runId, "owner", 17)
        .pipe(Stream.runCollect);
      expect(
        resumed
          .filter((frame) => frame._tag === "Event")
          .map((frame) => frame.event.sequence)
      ).toEqual(
        events
          .filter((event) => event.sequence > 17)
          .map((event) => event.sequence)
      );
      expect(
        yield* watcher
          .watch(run.runId, "owner", final.lastSequence)
          .pipe(Stream.runCollect)
      ).toHaveLength(1);
    })
  ));

test("watch bounds observer slots, authorizes before admission and releases interrupted observers", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      const watcher = createRunWatcher(store);
      const fibers = [];
      for (let index = 0; index < 16; index += 1) {
        const started = yield* Deferred.make<null>();
        fibers.push(
          yield* watcher.watch(run.runId, "owner").pipe(
            Stream.tap(() => Deferred.succeed(started, null)),
            Stream.runDrain,
            Effect.forkChild
          )
        );
        yield* Deferred.await(started);
      }
      expect(watcher.active).toBe(16);
      for (const [principal, after, expected] of [
        ["other", 0, "NotFound"],
        ["owner", 99, "InvalidInput"],
        ["owner", 0, "LimitExceeded"],
      ] as const) {
        const rejected = yield* watcher
          .watch(run.runId, principal, after)
          .pipe(Stream.runDrain, Effect.result);
        expect(rejected._tag).toBe("Failure");
        if (rejected._tag === "Failure") {
          expect(rejected.failure.code).toBe(expected);
        }
        expect(watcher.active).toBe(16);
      }
      yield* Fiber.interruptAll(fibers);
      expect(watcher.active).toBe(0);
      yield* watcher
        .watch(run.runId, "owner")
        .pipe(Stream.take(1), Stream.runDrain);
      expect(watcher.active).toBe(0);
    })
  ));

test("event pages bind their original high-water mark and stop at the byte budget", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      for (let index = 0; index < 150; index += 1) {
        yield* store.appendEvent(
          run.runId,
          `large-${index}`,
          "Progress",
          "x".repeat(8000)
        );
      }
      const first = yield* store.eventPage(
        { limit: 200, runId: run.runId },
        "owner"
      );
      expect(first.items.length).toBeLessThan(150);
      expect(first.cursor).not.toBeNull();
      yield* store.appendEvent(run.runId, "late", "Progress", null);
      if (first.cursor === null) {
        return yield* Effect.die("Expected cursor");
      }
      const second = yield* store.eventPage(
        { cursor: first.cursor, limit: 200, runId: run.runId },
        "owner"
      );
      expect(second.cursor).toBeNull();
      expect(second.snapshot).toBe(first.snapshot);
      expect(
        [...first.items, ...second.items].map((item) => item.sequence)
      ).toEqual(
        Array.from({ length: first.snapshot }, (_, index) => index + 1)
      );
      expect(
        (yield* Effect.result(
          store.eventPage(
            {
              afterSequence: 1,
              cursor: first.cursor,
              limit: 200,
              runId: run.runId,
            },
            "owner"
          )
        ))._tag
      ).toBe("Failure");
      const denied = yield* Effect.result(
        store.eventPage({ cursor: "invalid", runId: run.runId }, "other")
      );
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure") {
        expect(denied.failure.code).toBe("NotFound");
      }
    })
  ));

test("wait pages support open defaults, current settlements, fixed membership and private detail reads", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      const waits = [];
      for (let index = 0; index < 3; index += 1) {
        waits.push(
          yield* store.openWait({
            context: { private: true },
            deadline: Date.now() + 10_000,
            kind: "approval",
            nodeId: String(index),
            runId: run.runId,
          })
        );
      }
      const first = yield* store.waitPage({ limit: 1 }, "owner");
      expect(first.items[0]?.waitId).toBe(waits[0]?.waitId);
      expect(Object.hasOwn(first.items[0] ?? {}, "context")).toBe(false);
      expect((yield* store.waitPage({}, "other")).items).toHaveLength(0);
      const [, secondWait] = waits;
      if (first.cursor === null || !secondWait) {
        return yield* Effect.die("Missing test wait/cursor");
      }
      yield* store.settle(
        {
          operation: "approve",
          requestKey: "answer",
          waitId: secondWait.waitId,
        },
        "owner",
        () => null
      );
      yield* store.openWait({
        context: null,
        deadline: Date.now() + 10_000,
        kind: "approval",
        nodeId: "late",
        runId: run.runId,
      });
      const next = yield* store.waitPage(
        { cursor: first.cursor, limit: 1 },
        "owner"
      );
      expect(next.items).toHaveLength(1);
      expect(next.items[0]?.waitId).toBe(waits[2]?.waitId);
      expect(next.cursor).toBeNull();
      expect(
        (yield* store.waitPage({ status: "all" }, "owner")).items
      ).toHaveLength(4);
      expect(
        (yield* store.waitPage({ status: "Approved" }, "owner")).items
      ).toHaveLength(1);
      const denied = yield* Effect.result(
        store.getWait(secondWait.waitId, "other")
      );
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure") {
        expect(denied.failure.code).toBe("NotFound");
      }
      const oversized = yield* Effect.result(
        store.openWait({
          context: "x".repeat(65_536),
          deadline: Date.now() + 10_000,
          kind: "approval",
          nodeId: "big",
          runId: run.runId,
        })
      );
      expect(oversized._tag).toBe("Failure");
      if (oversized._tag === "Failure") {
        expect(oversized.failure.code).toBe("LimitExceeded");
      }
    })
  ));

test("telemetry stays within a per-run budget while lifecycle events and filtered log pages remain available", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      for (let index = 0; index < 1005; index += 1) {
        store.telemetry(run.runId, `log-${index}`, "Log", {
          attempt: 1,
          error: null,
          level: index % 2 === 0 ? "Info" : "Warn",
          message: "working",
          nodeId: "task",
        });
      }
      // Duplicate admission and later calls cannot consume unlimited storage.
      store.telemetry(run.runId, "log-0", "Log", {
        attempt: 1,
        error: null,
        level: "Info",
        message: "replayed",
        nodeId: "task",
      });
      const before = yield* store.getRun(run.runId);
      expect(before.lastSequence).toBe(1002);
      const first = yield* store.logPage(
        { level: "Warn", limit: 1, runId: run.runId },
        "owner"
      );
      expect(first.items[0]?.level).toBe("Warn");
      if (first.cursor === null) {
        return yield* Effect.die("Missing log cursor");
      }
      const second = yield* store.logPage(
        { cursor: first.cursor, level: "Warn", limit: 1, runId: run.runId },
        "owner"
      );
      expect(second.items[0]?.sequence).toBe(
        (first.items[0]?.sequence ?? 0) + 2
      );
      const changed = yield* Effect.result(
        store.logPage(
          { cursor: first.cursor, level: "Info", limit: 1, runId: run.runId },
          "owner"
        )
      );
      expect(changed._tag).toBe("Failure");
      yield* store.project(run.runId, "Succeeded", null);
      const tail = yield* store.events(run.runId, 1000);
      expect(tail.map((event) => event.tag)).toEqual([
        "Log",
        "TelemetryTruncated",
        "RunStatus",
      ]);
      expect(store.telemetryWriteFailures).toBe(0);
    })
  ));

test("drain commits before admission closes, keeps duplicate receipts and leaves replacement instances accepting", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      yield* store.beginInstance("first");
      const accepted = yield* store.submit(submission, "revision", "owner");
      const request = {
        gracePeriodMs: 100,
        instanceId: "first",
        requestKey: "stop",
      };
      const receipt = yield* store.drain(request);
      expect(yield* store.drain(request)).toEqual(receipt);
      expect((yield* store.daemonStatus()).drain).toEqual(receipt);
      expect((yield* store.submit(submission, "revision", "owner")).runId).toBe(
        accepted.runId
      );
      const rejected = yield* Effect.result(
        store.submit({ ...submission, requestKey: "new" }, "revision", "owner")
      );
      expect(rejected._tag).toBe("Failure");
      if (rejected._tag === "Failure") {
        expect(rejected.failure.code).toBe("Unavailable");
      }
      expect(
        (yield* Effect.result(store.drain({ ...request, gracePeriodMs: 200 })))
          ._tag
      ).toBe("Failure");
      yield* store.beginInstance("replacement");
      expect(yield* store.drain(request)).toEqual(receipt);
      expect((yield* store.daemonStatus()).drain).toBeNull();
      expect(
        (yield* store.submit(
          { ...submission, requestKey: "new" },
          "revision",
          "owner"
        )).status
      ).toBe("Queued");
    })
  ));

test("wait decisions authorize the run owner before looking up a receipt or closing an open wait", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      const wait = yield* store.openWait({
        context: null,
        deadline: Date.now() + 10_000,
        kind: "approval",
        nodeId: "review",
        runId: run.runId,
      });
      const request = {
        operation: "approve",
        requestKey: "answer",
        waitId: wait.waitId,
      } as const;
      const denied = yield* Effect.result(
        store.settle(request, "other", () => null)
      );
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure") {
        expect(denied.failure.code).toBe("NotFound");
      }
      expect((yield* store.getWait(wait.waitId)).status).toBe("Open");
      yield* store.settle(request, "owner", () => null);
      const duplicate = yield* Effect.result(
        store.settle(request, "other", () => null)
      );
      expect(duplicate._tag).toBe("Failure");
      if (duplicate._tag === "Failure") {
        expect(duplicate.failure.code).toBe("NotFound");
      }
    })
  ));

test("oversized normalized wait answers fail before settlement and retain the original answer key", async () =>
  await withStore((store) =>
    Effect.gen(function* () {
      const run = yield* store.submit(submission, "revision", "owner");
      const wait = yield* store.openWait({
        context: null,
        deadline: Date.now() + 10_000,
        kind: "input",
        nodeId: "answer",
        runId: run.runId,
      });
      const request = {
        input: "small",
        operation: "respond",
        requestKey: "answer",
        waitId: wait.waitId,
      } as const;
      const rejected = yield* Effect.result(
        store.settle(request, "owner", () => "x".repeat(1_048_576))
      );
      expect(rejected._tag).toBe("Failure");
      if (rejected._tag === "Failure") {
        expect(rejected.failure.code).toBe("LimitExceeded");
      }
      expect((yield* store.getWait(wait.waitId)).status).toBe("Open");
      expect(
        (yield* store.outbox()).filter((item) => item.kind === "Settle")
      ).toHaveLength(0);
      expect(
        (yield* store.settle(request, "owner", validateString)).outcome
      ).toBe("Responded");
    })
  ));

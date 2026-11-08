import { expect, test } from "bun:test";

import type { RunWatchFrame } from "@effectory/runtime/history-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect";

import { createProgress } from "../src/progress.ts";
import { ProgressSinkError } from "../src/text-line.ts";

type Frame = typeof RunWatchFrame.Type;
const snapshot = (
  lastSequence: number,
  status: "Running" | "Waiting" | "Succeeded" = "Succeeded"
): Frame => ({
  _tag: "Snapshot",
  run: {
    acceptedAt: new Date(0).toISOString(),
    kind: "workflow",
    lastSequence,
    revision: "revision",
    runId: "run",
    status,
    tags: {},
    targetId: "workflow",
  },
});
const event = (sequence: number): Frame => ({
  _tag: "Event",
  event: {
    at: new Date(0).toISOString(),
    payload: null,
    runId: "run",
    sequence,
    tag: "Test",
  },
});
const format = (frame: Frame) => {
  if (frame._tag === "Event") {
    return `E${frame.event.sequence}`;
  }
  if (frame._tag === "Snapshot") {
    return `S${frame.run.status}`;
  }
};
const writer = (lines: string[]) => (line: string) =>
  Effect.sync(() => {
    lines.push(line);
  });

test("human display drains an initially terminal forty-event burst exactly to its fixed barrier", async () => {
  const lines: string[] = [];
  const progress = createProgress(true, 0, writer(lines), format);
  let queries = 0;
  const frames = [
    snapshot(40),
    ...Array.from({ length: 50 }, (_, index) => event(index + 1)),
  ];
  const seen = await Effect.runPromise(
    Stream.fromArray(frames).pipe(
      Stream.rechunk(8),
      Stream.takeUntilEffect((frame) =>
        progress.process(frame, () =>
          Effect.sync(() => {
            queries += 1;
            return true;
          })
        )
      ),
      Stream.runCollect
    )
  );
  expect(queries).toBe(1);
  expect(seen).toHaveLength(41);
  expect(lines.at(-1)).toBe("E40");
  expect(lines).not.toContain("E41");
  expect(progress.cursor).toBe(40);
});

test("later snapshots never move the barrier or re-query a wait, including after the wait settles", async () => {
  const lines: string[] = [];
  const progress = createProgress(true, 0, writer(lines), format);
  let queries = 0;
  const seen = await Effect.runPromise(
    Stream.fromArray([
      snapshot(20, "Waiting"),
      ...Array.from({ length: 16 }, (_, index) => event(index + 1)),
      snapshot(60, "Running"),
      ...Array.from({ length: 44 }, (_, index) => event(index + 17)),
    ]).pipe(
      Stream.takeUntilEffect((frame) =>
        progress.process(frame, () =>
          Effect.sync(() => {
            expect(lines.at(-1)).toBe("SWaiting");
            queries += 1;
            return queries === 1;
          })
        )
      ),
      Stream.runCollect
    )
  );
  expect(queries).toBe(1);
  expect(seen.at(-1)).toEqual(event(20));
  expect(lines.at(-1)).toBe("E20");
  expect(progress.cursor).toBe(20);
});

test("machine mode suppresses formatting, tracks consumption and retains immediate stop timing", async () => {
  const progress = createProgress(
    false,
    7,
    () => Effect.die("must not write"),
    () => {
      throw new Error("must not format");
    }
  );
  const seen = await Effect.runPromise(
    Stream.fromArray([event(8), snapshot(40), event(9)]).pipe(
      Stream.takeUntilEffect((frame) =>
        progress.process(frame, () => Effect.succeed(true))
      ),
      Stream.runCollect
    )
  );
  expect(seen).toEqual([event(8), snapshot(40)]);
  expect(progress.cursor).toBe(8);
  const atEnd = createProgress(true, 40, () => Effect.void, format);
  expect(
    await Effect.runPromise(
      atEnd.process(snapshot(40), () => Effect.succeed(true))
    )
  ).toBe(true);
  expect(atEnd.cursor).toBe(40);
});

test("a broken progress sink disables only display and keeps immediate observation semantics", async () => {
  let writes = 0;
  const progress = createProgress(
    true,
    7,
    () => {
      writes += 1;
      return Effect.fail(
        new ProgressSinkError({ cause: new Error("broken pipe") })
      );
    },
    format
  );
  const seen = await Effect.runPromise(
    Stream.fromArray([
      snapshot(8, "Running"),
      event(8),
      snapshot(9),
      event(9),
    ]).pipe(
      Stream.takeUntilEffect((frame) =>
        progress.process(frame, (value) =>
          Effect.succeed(value.run.status === "Succeeded")
        )
      ),
      Stream.runCollect
    )
  );
  expect(writes).toBe(1);
  expect(seen).toHaveLength(3);
  // Human mode never claims unread or undisplayed events were written.
  expect(progress.cursor).toBe(7);
});

test("sink failure during a drain stops on the failing element without querying the wait again", async () => {
  let queries = 0;
  const lines: string[] = [];
  const progress = createProgress(
    true,
    0,
    (line) =>
      line === "E2"
        ? Effect.fail(new ProgressSinkError({ cause: "closed" }))
        : writer(lines)(line),
    format
  );
  const seen = await Effect.runPromise(
    Stream.fromArray([
      snapshot(40, "Waiting"),
      event(1),
      event(2),
      snapshot(50, "Running"),
      event(3),
    ]).pipe(
      Stream.takeUntilEffect((frame) =>
        progress.process(frame, () =>
          Effect.sync(() => {
            queries += 1;
            return true;
          })
        )
      ),
      Stream.runCollect
    )
  );
  expect(queries).toBe(1);
  expect(seen.at(-1)).toEqual(event(2));
  expect(lines).toEqual(["SWaiting", "E1"]);
  expect(progress.cursor).toBe(1);
});

test("formatter defects and RPC limits are never swallowed as progress degradation", async () => {
  let writes = 0;
  const progress = createProgress(
    true,
    0,
    () =>
      Effect.sync(() => {
        writes += 1;
      }),
    () => {
      throw new Error("formatter failed");
    }
  );
  const result = await Effect.runPromiseExit(
    progress.process(event(1), () => Effect.succeed(false))
  );
  expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(true);
  expect(writes).toBe(0);
  const limit = new OperationError({
    code: "LimitExceeded",
    message: "oversized event",
  });
  const drain = createProgress(true, 0, () => Effect.void, format);
  const error = await Effect.runPromise(
    Stream.make(snapshot(40), event(1)).pipe(
      Stream.concat(Stream.fail(limit)),
      Stream.takeUntilEffect((frame) =>
        drain.process(frame, () => Effect.succeed(true))
      ),
      Stream.runDrain,
      Effect.flip
    )
  );
  expect(error).toBe(limit);
  expect(drain.cursor).toBe(1);
});

test("a stalled progress write applies backpressure and remains interruptible", async () => {
  let closed = false;
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<boolean>();
        const progress = createProgress(
          true,
          0,
          () =>
            Deferred.succeed(started, true).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  closed = true;
                })
              )
            ),
          format
        );
        const child = yield* Effect.forkScoped(
          progress.process(event(1), () => Effect.succeed(false))
        );
        yield* Deferred.await(started);
        expect(progress.cursor).toBe(0);
        yield* Fiber.interrupt(child);
        return yield* Fiber.await(child);
      })
    )
  );
  expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(
    true
  );
  expect(closed).toBe(true);
});

test("snapshot status deduplication is local to each observation and heartbeats stay quiet", async () => {
  const lines: string[] = [];
  const first = createProgress(true, 0, writer(lines), format);
  const second = createProgress(true, 0, writer(lines), format);
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* first.process(snapshot(1, "Running"), () => Effect.succeed(false));
      yield* first.process(snapshot(2, "Running"), () => Effect.succeed(false));
      yield* first.process(
        {
          _tag: "Heartbeat",
          at: new Date(0).toISOString(),
          lastSequence: 2,
          runId: "run",
        },
        () => Effect.succeed(false)
      );
      yield* second.process(snapshot(2, "Running"), () =>
        Effect.succeed(false)
      );
    })
  );
  expect(lines).toEqual(["SRunning", "SRunning"]);
});

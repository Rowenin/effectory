import { describe, expect, test } from "bun:test";

import { Duration, Effect, Schema } from "effect";

import { Flow } from "../src/index.ts";

const run = <A, E>(program: Effect.Effect<A, E, Flow.RunStore>) =>
  Effect.runPromise(program.pipe(Effect.provide(Flow.memoryStore)));

/** A Task that fails `failures` times, then succeeds. */
const makeFlaky = (failures: number, retry?: Flow.RetryPolicy) => {
  let attempts = 0;
  const Flaky = Flow.Task(
    "Flaky",
    {
      input: Schema.Void,
      output: Schema.Finite,
      ...(retry === undefined ? {} : { retry }),
    },
    () =>
      Effect.succeed({
        run: Effect.suspend(() => {
          attempts += 1;
          return attempts <= failures
            ? Effect.fail(`attempt ${attempts} failed` as const)
            : Effect.succeed(attempts);
        }),
      })
  );
  return { Flaky, attempts: () => attempts };
};

describe("retries", () => {
  test("failed work runs again up to `times` more", async () => {
    const { Flaky } = makeFlaky(2, { delay: "1 millis", times: 2 });
    const result = await run(
      Effect.gen(function* program() {
        const outcome = yield* Flow.start(Flaky);
        const { nodes } = yield* Flow.status(outcome.runId);
        return { nodes, outcome };
      })
    );
    expect(result.outcome).toMatchObject({ _tag: "Succeeded", output: 3 });
    expect(result.nodes).toEqual([
      expect.objectContaining({ attempts: 3, status: "succeeded" }),
    ]);
  });

  test("the last failure stands once retries run out", async () => {
    const { Flaky, attempts } = makeFlaky(5, { times: 1 });
    const error = await Effect.runPromise(
      Flow.plan(Flaky).pipe(Effect.flatMap(Flow.run), Effect.flip)
    );
    expect(error).toBe("attempt 2 failed");
    expect(attempts()).toBe(2);
  });

  test("waiting for an Input is not retried", async () => {
    const Confirm = Flow.Input("Confirm", {
      input: Schema.Void,
      output: Schema.Boolean,
    });
    let attempts = 0;
    const Ask = Flow.Task(
      "Ask",
      { input: Schema.Void, output: Schema.Boolean, retry: { times: 5 } },
      () =>
        Effect.gen(function* ask() {
          const confirm = yield* Flow.Calls(Confirm);
          return {
            run: Effect.suspend(() => {
              attempts += 1;
              return confirm();
            }),
          };
        })
    );
    const outcome = await run(Flow.start(Ask));
    expect(outcome._tag).toBe("Suspended");
    expect(attempts).toBe(1);
  });
});

describe("timeouts", () => {
  const Slow = Flow.Task(
    "Slow",
    { input: Schema.Finite, output: Schema.String, timeout: "50 millis" },
    (millis) =>
      Effect.succeed({
        run: Effect.as(Effect.sleep(Duration.millis(millis)), "done"),
      })
  );

  test("an attempt that runs too long fails with TaskTimeout", async () => {
    const error = await Effect.runPromise(
      Flow.plan(Slow, 1000).pipe(Effect.flatMap(Flow.run), Effect.flip)
    );
    expect(error).toEqual(
      new Flow.TaskTimeout({
        key: "Slow(1000)",
        message: "Slow(1000) took longer than 50ms",
      })
    );
    expect(
      await Effect.runPromise(Flow.plan(Slow, 1).pipe(Effect.flatMap(Flow.run)))
    ).toBe("done");
  });

  test("TaskTimeout is in a Task's errors only when it has a timeout", () => {
    const timedOut: Flow.TaskTimeout extends Flow.ErrorOf<typeof Slow>
      ? true
      : false = true;
    const { Flaky } = makeFlaky(0);
    const never: Flow.TaskTimeout extends Flow.ErrorOf<typeof Flaky>
      ? true
      : false = false;
    expect([timedOut, never]).toEqual([true, false]);
  });

  test("each retry gets its own timeout", async () => {
    let attempts = 0;
    const Recovers = Flow.Task(
      "Recovers",
      {
        input: Schema.Void,
        output: Schema.Finite,
        retry: { times: 1 },
        timeout: "50 millis",
      },
      () =>
        Effect.succeed({
          run: Effect.suspend(() => {
            attempts += 1;
            return attempts === 1 ? Effect.never : Effect.succeed(attempts);
          }),
        })
    );
    expect(
      await Effect.runPromise(
        Flow.plan(Recovers).pipe(Effect.flatMap(Flow.run))
      )
    ).toBe(2);
  });
});

/** Tasks that record how many of them are working at once. */
const makeWorkers = (concurrency?: number) => {
  let active = 0;
  let peak = 0;
  const Work = Flow.Task(
    "Work",
    {
      input: Schema.Finite,
      output: Schema.Finite,
      ...(concurrency === undefined ? {} : { concurrency }),
    },
    (n) =>
      Effect.succeed({
        run: Effect.gen(function* work() {
          active += 1;
          peak = Math.max(peak, active);
          yield* Effect.sleep(Duration.millis(10));
          active -= 1;
          return n;
        }),
      })
  );
  const All = Flow.Task(
    "All",
    { input: Schema.Void, output: Schema.Finite },
    () =>
      Effect.gen(function* all() {
        const handles = yield* Effect.forEach([1, 2, 3, 4, 5, 6], (n) =>
          Flow.After(Work, n)
        );
        return {
          run: Effect.map(
            Effect.forEach(handles, (handle) => handle.output),
            (values) => values.reduce((a, b) => a + b, 0)
          ),
        };
      })
  );
  return { All, peak: () => peak };
};

describe("concurrency", () => {
  test("without a limit, independent nodes all work at once", async () => {
    const { All, peak } = makeWorkers();
    await Effect.runPromise(Flow.plan(All).pipe(Effect.flatMap(Flow.run)));
    expect(peak()).toBe(6);
  });

  test("Concurrency limits nodes working at once in a run", async () => {
    const { All, peak } = makeWorkers();
    const total = await Effect.runPromise(
      Flow.plan(All).pipe(
        Effect.flatMap(Flow.run),
        Effect.provideService(Flow.Concurrency, 2)
      )
    );
    expect(total).toBe(21);
    expect(peak()).toBe(2);
  });

  test("a Task's concurrency limits its own nodes", async () => {
    const { All, peak } = makeWorkers(3);
    await Effect.runPromise(Flow.plan(All).pipe(Effect.flatMap(Flow.run)));
    expect(peak()).toBe(3);
  });

  test("a caller lets go of its slot while waiting, so a limit of 1 can't deadlock", async () => {
    const Leaf = Flow.Task(
      "Leaf",
      { input: Schema.Finite, output: Schema.Finite },
      (n) => Effect.succeed({ run: Effect.succeed(n * 2) })
    );
    const Caller = Flow.Task(
      "Caller",
      { input: Schema.Void, output: Schema.Finite },
      () =>
        Effect.gen(function* caller() {
          const leaf = yield* Flow.Calls(Leaf);
          return {
            run: Effect.gen(function* callerRun() {
              const a = yield* leaf(1);
              const b = yield* leaf(2);
              return a + b;
            }),
          };
        })
    );
    const total = await Effect.runPromise(
      Flow.plan(Caller).pipe(
        Effect.flatMap(Flow.run),
        Effect.provideService(Flow.Concurrency, 1),
        Effect.timeout("2 seconds")
      )
    );
    expect(total).toBe(6);
  });
});

describe("timers", () => {
  const Cooldown = Flow.Timer("Cooldown", {
    description: "Waits before deploying.",
    input: Schema.Finite,
    wait: (millis) => Duration.millis(millis),
  });
  const Deploy = Flow.Task(
    "Deploy",
    { input: Schema.Finite, output: Schema.String },
    (millis) =>
      Effect.gen(function* deploy() {
        const woke = yield* Flow.After(Cooldown, millis);
        return {
          run: Effect.map(woke.output, (at) => `deployed after ${typeof at}`),
        };
      })
  );

  test("a Timer due soon is waited for in the process", async () => {
    const before = Date.now();
    const result = await Effect.runPromise(
      Flow.plan(Deploy, 30).pipe(Effect.flatMap(Flow.run))
    );
    expect(result).toBe("deployed after number");
    expect(Date.now() - before).toBeGreaterThanOrEqual(25);
  });

  test("a later Timer suspends the run until it wakes, keeping its wake time", async () => {
    const result = await run(
      Effect.gen(function* program() {
        const first = yield* Flow.start(Deploy, 150);
        const early = yield* Flow.resume(Deploy, first.runId);
        yield* Effect.sleep(Duration.millis(200));
        const late = yield* Flow.resume(Deploy, first.runId);
        return { early, first, late };
      }).pipe(Effect.provideService(Flow.InProcessWait, Duration.zero))
    );
    expect(result.first).toMatchObject({
      _tag: "Suspended",
      pending: [],
      timers: [{ key: "Cooldown(150)", name: "Cooldown" }],
    });
    const wakeAt =
      result.first._tag === "Suspended" ? result.first.timers[0]?.wakeAt : 0;
    // Resuming early doesn't restart the wait.
    expect(result.early).toMatchObject({
      _tag: "Suspended",
      timers: [{ wakeAt }],
    });
    expect(result.late).toMatchObject({
      _tag: "Succeeded",
      output: "deployed after number",
    });
  });
});

describe("the record of a run", () => {
  test("status lists the edges the run followed, and toMermaidRun draws them", async () => {
    const Leaf = Flow.Task(
      "Leaf",
      { input: Schema.Finite, output: Schema.Finite },
      (n) => Effect.succeed({ run: Effect.succeed(n) })
    );
    const Setup = Flow.Task(
      "Setup",
      { input: Schema.Void, output: Schema.Void },
      () => Effect.succeed({ run: Effect.void })
    );
    const Root = Flow.Task(
      "Root",
      { input: Schema.Void, output: Schema.Finite },
      () =>
        Effect.gen(function* root() {
          yield* Flow.After(Setup);
          const leaf = yield* Flow.Calls(Leaf);
          return { run: leaf(7) };
        })
    );
    const state = await run(
      Effect.gen(function* program() {
        const outcome = yield* Flow.start(Root);
        return yield* Flow.status(outcome.runId);
      })
    );
    expect(state.edges).toEqual([
      { from: "Setup(null)", kind: "after", to: "Root(null)" },
      { from: "Root(null)", kind: "call", to: "Leaf(7)" },
    ]);
    const mermaid = Flow.toMermaidRun(state);
    expect(mermaid).toContain("n0 --> n1");
    expect(mermaid).toContain("-.->");
    expect(mermaid).toContain(":::succeeded");
  });

  test("Flow.make passes its concurrency to runs", async () => {
    let active = 0;
    let peak = 0;
    const Work = Flow.Task(
      "Work",
      { input: Schema.Finite, output: Schema.Finite },
      (n) =>
        Effect.succeed({
          run: Effect.gen(function* work() {
            active += 1;
            peak = Math.max(peak, active);
            yield* Effect.sleep(Duration.millis(10));
            active -= 1;
            return n;
          }),
        })
    );
    const Both = Flow.Task(
      "Both",
      { input: Schema.Void, output: Schema.Void },
      () =>
        Effect.gen(function* both() {
          yield* Flow.After(Work, 1);
          yield* Flow.After(Work, 2);
          yield* Flow.After(Work, 3);
          return { run: Effect.void };
        })
    );
    const app = Flow.make({ concurrency: 1, tasks: [Both, Work] });
    await run(app.start("Both", null));
    expect(peak).toBe(1);
  });
});

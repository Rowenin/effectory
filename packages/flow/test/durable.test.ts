import { describe, expect, test } from "bun:test";

import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { DateTime, Effect, Layer, Option, Schema } from "effect";

import { Flow } from "../src/index.ts";

const Decision = Schema.Union([
  Schema.TaggedStruct("Approve", { by: Schema.String }),
  Schema.TaggedStruct("Revise", { notes: Schema.String }),
]);

const ApprovePlan = Flow.Input("ApprovePlan", {
  input: Schema.String,
  output: Decision,
});

/**
 * Draft, then ask a person until they approve, then implement. `events`
 * shows which work ran, across runs.
 */
const makeTasks = (options: { flakyImplement?: boolean } = {}) => {
  const events: string[] = [];
  let implementAttempts = 0;

  const Draft = Flow.Task(
    "Draft",
    {
      input: Schema.Struct({
        goal: Schema.String,
        notes: Schema.optional(Schema.String),
      }),
      output: Schema.String,
    },
    ({ goal, notes }) =>
      Effect.succeed({
        run: Effect.sync(() => {
          events.push(`draft(${notes ?? ""})`);
          return notes === undefined ? `${goal} v0` : `${goal} (${notes})`;
        }),
      })
  );

  const Approve = Flow.Task(
    "Approve",
    { input: Schema.String, output: Schema.String },
    (goal) =>
      Effect.gen(function* approve() {
        const first = yield* Flow.After(Draft, { goal });
        const draft = yield* Flow.Calls(Draft);
        const ask = yield* Flow.Calls(ApprovePlan);
        return {
          run: Effect.gen(function* approveRun() {
            let plan = yield* first.output;
            for (;;) {
              const decision = yield* ask(plan);
              if (decision._tag === "Approve") {
                return plan;
              }
              plan = yield* draft({ goal, notes: decision.notes });
            }
          }),
        };
      })
  );

  const Implement = Flow.Task(
    "Implement",
    { input: Schema.String, output: Schema.DateTimeUtcFromString },
    (goal) =>
      Effect.gen(function* implement() {
        const approved = yield* Flow.After(Approve, goal);
        return {
          run: Effect.gen(function* implementRun() {
            yield* approved.output;
            implementAttempts += 1;
            events.push("implement");
            if (options.flakyImplement && implementAttempts === 1) {
              return yield* Effect.fail("build broke" as const);
            }
            // A value whose JSON form differs from its type.
            return DateTime.makeUnsafe("2026-10-28T12:00:00.000Z");
          }),
        };
      })
  );

  return { Implement, events };
};

const stores = [
  ["memory", Flow.memoryStore],
  [
    "sqlite",
    Flow.sqlStore.pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
      Layer.orDie
    ),
  ],
] as const;

/** Run a program against a fresh store. */
const runWith =
  (store: Layer.Layer<Flow.RunStore>) =>
  <A, E>(program: Effect.Effect<A, E, Flow.RunStore>) =>
    Effect.runPromise(program.pipe(Effect.provide(store)));

/** The reason a resume was refused. */
const reason = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error as Flow.ResumeError).reason)
  );

const ask = (plan: string) => `ApprovePlan(${JSON.stringify(plan)})`;

describe.each(stores)("durable runs (%s)", (_name, store) => {
  const run = runWith(store);

  test("a run suspends, resumes with responses, and skips finished work", async () => {
    const { Implement, events } = makeTasks();
    const result = await run(
      Effect.gen(function* program() {
        const first = yield* Flow.start(Implement, "ship");
        expect(first).toMatchObject({
          _tag: "Suspended",
          pending: [{ key: ask("ship v0"), request: "ship v0" }],
        });

        const second = yield* Flow.resume(Implement, first.runId, {
          responses: { [ask("ship v0")]: { _tag: "Revise", notes: "tests" } },
        });
        expect(second).toMatchObject({
          _tag: "Suspended",
          pending: [{ key: ask("ship (tests)") }],
        });

        const third = yield* Flow.resume(Implement, first.runId, {
          responses: { [ask("ship (tests)")]: { _tag: "Approve", by: "dana" } },
        });
        const state = yield* Flow.status(first.runId);
        return { state, third };
      })
    );

    expect(result.third._tag).toBe("Succeeded");
    // Each piece of work ran once across three runs.
    expect(events).toEqual(["draft()", "draft(tests)", "implement"]);
    expect(result.state.run.status).toBe("succeeded");
    // Stored through the schema's JSON codec, not as a DateTime object.
    expect(result.state.run.output).toBe("2026-10-28T12:00:00.000Z");
    expect(
      result.state.nodes.map(({ attempts, key, status }) => ({
        attempts,
        key,
        status,
      }))
    ).toEqual([
      { attempts: 1, key: 'Draft({"goal":"ship"})', status: "succeeded" },
      // Approve holds the loop, so it runs on every resume and replays its
      // calls from the store.
      { attempts: 3, key: 'Approve("ship")', status: "succeeded" },
      // An Input's attempts: asked, then answered.
      { attempts: 2, key: ask("ship v0"), status: "succeeded" },
      {
        attempts: 1,
        key: 'Draft({"goal":"ship","notes":"tests"})',
        status: "succeeded",
      },
      { attempts: 2, key: ask("ship (tests)"), status: "succeeded" },
      { attempts: 1, key: 'Implement("ship")', status: "succeeded" },
    ]);
  });

  test("resuming a finished run returns its output without running", async () => {
    const { Implement, events } = makeTasks();
    await run(
      Effect.gen(function* program() {
        const first = yield* Flow.start(Implement, "ship");
        yield* Flow.resume(Implement, first.runId, {
          responses: { [ask("ship v0")]: { _tag: "Approve", by: "dana" } },
        });
        events.length = 0;
        const again = yield* Flow.resume(Implement, first.runId);
        expect(again._tag).toBe("Succeeded");
      })
    );
    expect(events).toEqual([]);
  });

  test("a failed node runs again on resume; finished ones don't", async () => {
    const { Implement, events } = makeTasks({ flakyImplement: true });
    await run(
      Effect.gen(function* program() {
        const first = yield* Flow.start(Implement, "ship");
        const failed = yield* Flow.resume(Implement, first.runId, {
          responses: { [ask("ship v0")]: { _tag: "Approve", by: "dana" } },
        });
        expect(failed._tag).toBe("Failed");
        expect((yield* Flow.status(first.runId)).run.status).toBe("failed");

        const retried = yield* Flow.resume(Implement, first.runId);
        expect(retried._tag).toBe("Succeeded");
        const { nodes } = yield* Flow.status(first.runId);
        expect(
          nodes.find((node) => node.key === 'Implement("ship")')
        ).toMatchObject({
          attempts: 2,
          status: "succeeded",
        });
      })
    );
    expect(events).toEqual(["draft()", "implement", "implement"]);
  });

  test("a rejected response keeps the Input pending until a valid one", async () => {
    const { Implement } = makeTasks();
    await run(
      Effect.gen(function* program() {
        const first = yield* Flow.start(Implement, "ship");
        const rejected = yield* Flow.resume(Implement, first.runId, {
          responses: { [ask("ship v0")]: { _tag: "Approve" } },
        });
        expect(rejected).toMatchObject({
          _tag: "Suspended",
          pending: [{ key: ask("ship v0"), rejected: expect.any(String) }],
        });
        const accepted = yield* Flow.resume(Implement, first.runId, {
          responses: { [ask("ship v0")]: { _tag: "Approve", by: "dana" } },
        });
        expect(accepted._tag).toBe("Succeeded");
      })
    );
  });

  test("resume refuses what it can't apply", async () => {
    const { Implement } = makeTasks();
    const Other = Flow.Task(
      "Other",
      { input: Schema.String, output: Schema.String },
      (goal) => Effect.succeed({ run: Effect.succeed(goal) })
    );
    // Same name and input as Implement, but a different plan.
    const Changed = Flow.Task(
      "Implement",
      { input: Schema.String, output: Schema.DateTimeUtcFromString },
      (goal) =>
        Effect.gen(function* changed() {
          yield* Flow.After(Other, goal);
          return { run: Effect.die("unreachable") };
        })
    );

    const reasons = await run(
      Effect.gen(function* program() {
        const { runId } = yield* Flow.start(Implement, "ship");
        return [
          yield* reason(Flow.resume(Implement, "nope")),
          yield* reason(Flow.resume(Other, runId)),
          yield* reason(Flow.resume(Changed, runId)),
          yield* reason(
            Flow.resume(Implement, runId, {
              responses: {
                [ask("something else")]: { _tag: "Approve", by: "x" },
              },
            })
          ),
        ];
      })
    );
    expect(reasons).toEqual([
      "not-found",
      "task-mismatch",
      "plan-changed",
      "unexpected-response",
    ]);
  });

  test("each run keeps its own state", async () => {
    const { Implement } = makeTasks();
    const pending = await run(
      Effect.gen(function* program() {
        const a = yield* Flow.start(Implement, "a");
        const b = yield* Flow.start(Implement, "b");
        expect(a.runId).not.toBe(b.runId);
        const db = yield* Flow.RunStore;
        return Option.getOrThrow(yield* db.getRun(b.runId)).pending;
      })
    );
    expect(pending.map((input) => input.key)).toEqual([ask("b v0")]);
  });

  test("a run suspends at every pending Input after independent work", async () => {
    const events: string[] = [];
    const Confirm = Flow.Input("Confirm", {
      input: Schema.String,
      output: Schema.Boolean,
    });
    const Lint = Flow.Task(
      "Lint",
      { input: Schema.Void, output: Schema.Boolean },
      () =>
        Effect.succeed({
          run: Effect.sync(() => {
            events.push("lint");
            return true;
          }),
        })
    );
    const Deploy = Flow.Task(
      "Deploy",
      { input: Schema.String, output: Schema.String },
      (where) =>
        Effect.gen(function* deploy() {
          const confirmed = yield* Flow.After(Confirm, where);
          return {
            run: Effect.gen(function* deployRun() {
              yield* confirmed.output;
              events.push(`deploy(${where})`);
              return where;
            }),
          };
        })
    );
    const Release = Flow.Task(
      "Release",
      { input: Schema.Void, output: Schema.String },
      () =>
        Effect.gen(function* release() {
          yield* Flow.After(Lint);
          const staging = yield* Flow.After(Deploy, "staging");
          const docs = yield* Flow.After(Deploy, "docs");
          return {
            run: Effect.all([staging.output, docs.output]).pipe(
              Effect.map((both) => both.join("+"))
            ),
          };
        })
    );

    await run(
      Effect.gen(function* program() {
        const first = yield* Flow.start(Release);
        expect(first._tag).toBe("Suspended");
        expect(
          first._tag === "Suspended" && first.pending.map((input) => input.key)
        ).toEqual(['Confirm("docs")', 'Confirm("staging")']);
        // Lint didn't need either answer, so it ran and is stored.
        expect(events).toEqual(["lint"]);
        const statuses = Object.fromEntries(
          (yield* Flow.status(first.runId)).nodes.map((node) => [
            node.key,
            node.status,
          ])
        );
        expect(statuses).toMatchObject({
          'Confirm("docs")': "waiting",
          'Confirm("staging")': "waiting",
          "Lint(null)": "succeeded",
        });

        const second = yield* Flow.resume(Release, first.runId, {
          responses: { 'Confirm("staging")': true },
        });
        expect(second).toMatchObject({
          _tag: "Suspended",
          pending: [{ key: 'Confirm("docs")' }],
        });
        const third = yield* Flow.resume(Release, first.runId, {
          responses: { 'Confirm("docs")': true },
        });
        expect(third).toMatchObject({
          _tag: "Succeeded",
          output: "staging+docs",
        });
      })
    );
    expect(events).toEqual(["lint", "deploy(staging)", "deploy(docs)"]);
  });

  test("a real failure ends the run even while Inputs are pending", async () => {
    const Confirm = Flow.Input("Confirm", {
      input: Schema.Void,
      output: Schema.Boolean,
    });
    const Broken = Flow.Task(
      "Broken",
      { input: Schema.Void, output: Schema.Boolean },
      () => Effect.succeed({ run: Effect.fail("broken" as const) })
    );
    const Both = Flow.Task(
      "Both",
      { input: Schema.Void, output: Schema.Boolean },
      () =>
        Effect.gen(function* both() {
          yield* Flow.After(Confirm);
          yield* Flow.After(Broken);
          return { run: Effect.succeed(true) };
        })
    );
    const outcome = await run(Flow.start(Both));
    expect(outcome._tag).toBe("Failed");
  });

  test("a run held by another process is busy until its lease lapses", async () => {
    const { Implement } = makeTasks();
    const reasons = await run(
      Effect.gen(function* program() {
        const { runId } = yield* Flow.start(Implement, "ship");
        const db = yield* Flow.RunStore;
        const now = Date.now();
        yield* db.claim(runId, "someone else", { now, until: now + 60_000 });
        const busy = yield* reason(Flow.resume(Implement, runId));

        // The other owner crashed: its lease lapses and the run can resume.
        yield* db.claim(runId, "someone else", { now, until: now - 1 });
        const resumed = yield* Flow.resume(Implement, runId, {
          responses: { [ask("ship v0")]: { _tag: "Approve", by: "dana" } },
        });
        return [busy, resumed._tag];
      })
    );
    expect(reasons).toEqual(["busy", "Succeeded"]);
  });
});

// oxlint-disable-next-line max-classes-per-file -- test errors and services.
import { describe, expect, test } from "bun:test";

import { Context, Data, Effect, Exit, Schema } from "effect";

import { Flow } from "../src/index.ts";

class NotApproved extends Data.TaggedError("NotApproved")<{
  readonly rounds: number;
}> {}

const Verdict = Schema.Struct({
  approved: Schema.Boolean,
  notes: Schema.String,
});

/**
 * A planner and a reviewer. The reviewer approves once `approveAt` rounds of
 * feedback have been applied; `stuck` makes the planner ignore feedback.
 */
const makeAgents = (options: { approveAt: number; stuck?: boolean }) => {
  const calls: string[] = [];

  const GatherContext = Flow.Task(
    "GatherContext",
    { input: Schema.String, output: Schema.String },
    (goal) =>
      Effect.succeed({
        run: Effect.sync(() => {
          calls.push("context");
          return `context for ${goal}`;
        }),
      })
  );

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
      Effect.gen(function* draft() {
        const context = yield* Flow.After(GatherContext, goal);
        return {
          run: Effect.gen(function* draftRun() {
            yield* context.output;
            calls.push(`draft(${notes ?? ""})`);
            const revisions = options.stuck ? 0 : (notes?.length ?? 0);
            return `${goal} v${revisions}`;
          }),
        };
      })
  );

  const Review = Flow.Task(
    "Review",
    { input: Schema.String, output: Verdict },
    (draft) =>
      Effect.succeed({
        run: Effect.sync(() => {
          calls.push(`review(${draft})`);
          const revisions = Number(draft.split(" v")[1]);
          return {
            approved: revisions >= options.approveAt,
            notes: "x".repeat(revisions + 1),
          };
        }),
      })
  );

  const Refine = Flow.Task(
    "Refine",
    { input: Schema.String, output: Schema.String },
    (goal) =>
      Effect.gen(function* refine() {
        yield* Flow.After(GatherContext, goal);
        const draft = yield* Flow.Calls(Draft, { max: 3 });
        const review = yield* Flow.Calls(Review, { max: 3 });
        return {
          run: Effect.gen(function* refineRun() {
            let notes: string | undefined;
            for (let round = 0; round < 3; round += 1) {
              const plan = yield* draft(
                notes === undefined ? { goal } : { goal, notes }
              );
              const verdict = yield* review(plan);
              if (verdict.approved) {
                return plan;
              }
              ({ notes } = verdict);
            }
            return yield* new NotApproved({ rounds: 3 });
          }),
        };
      })
  );

  return { Draft, Refine, Review, calls };
};

describe("Flow.Calls", () => {
  test("the plan records declared calls without planning them", async () => {
    const { Refine } = makeAgents({ approveAt: 1 });
    const plan = await Effect.runPromise(Flow.plan(Refine, "ship"));

    expect([...plan.nodes.keys()]).toEqual([
      'GatherContext("ship")',
      'Refine("ship")',
    ]);
    expect(plan.nodes.get('Refine("ship")')?.node.calls).toEqual([
      { kind: "task", max: 3, name: "Draft" },
      { kind: "task", max: 3, name: "Review" },
    ]);
    const mermaid = Flow.toMermaid(plan).split("\n");
    expect(mermaid).toContain('  call0["Draft#40;…#41;"]');
    expect(mermaid).toContain('  1 -.->|"≤3"| call0');
    expect(mermaid).toContain('  1 -.->|"≤3"| call1');
  });

  test("the loop stops once the reviewer approves", async () => {
    const { calls, Refine } = makeAgents({ approveAt: 1 });
    const result = await Effect.runPromise(
      Flow.plan(Refine, "ship").pipe(Effect.flatMap(Flow.run))
    );

    expect(result).toBe("ship v1");
    // GatherContext runs once, though Refine and every Draft run after it.
    expect(calls).toEqual([
      "context",
      "draft()",
      "review(ship v0)",
      "draft(x)",
      "review(ship v1)",
    ]);
  });

  test("the caller's own errors end the loop", async () => {
    const { calls, Refine } = makeAgents({ approveAt: 99 });
    const error = await Effect.runPromise(
      Flow.plan(Refine, "ship").pipe(Effect.flatMap(Flow.run), Effect.flip)
    );
    expect(error).toEqual(new NotApproved({ rounds: 3 }));
    expect(calls.filter((call) => call.startsWith("draft"))).toHaveLength(3);
  });

  test("a repeated call reuses the node's output", async () => {
    const { calls, Refine } = makeAgents({ approveAt: 99, stuck: true });
    await Effect.runPromiseExit(
      Flow.plan(Refine, "ship").pipe(Effect.flatMap(Flow.run))
    );
    // The stuck planner drafts "ship v0" every round, so Review("ship v0") is
    // one node; the notes repeat too, so rounds 2 and 3 share a Draft node.
    expect(calls).toEqual([
      "context",
      "draft()",
      "review(ship v0)",
      "draft(x)",
    ]);
  });

  test("going over max fails the call with a CallError", async () => {
    const { Review } = makeAgents({ approveAt: 0 });
    const Greedy = Flow.Task(
      "Greedy",
      { input: Schema.Void, output: Schema.Void },
      () =>
        Effect.gen(function* greedy() {
          const review = yield* Flow.Calls(Review, { max: 1 });
          return {
            run: Effect.gen(function* greedyRun() {
              yield* review("a v0");
              yield* review("b v0");
            }),
          };
        })
    );
    const error = await Effect.runPromise(
      Flow.plan(Greedy).pipe(Effect.flatMap(Flow.run), Effect.flip)
    );
    expect(error).toEqual(
      new Flow.CallError({
        message: "Greedy(undefined) called Review more than 1 times",
        reason: "limit",
      })
    );
  });

  test("a failed call fails only its caller, which may recover", async () => {
    const Flaky = Flow.Task(
      "Flaky",
      { input: Schema.Void, output: Schema.String },
      () => Effect.succeed({ run: Effect.fail("agent timed out" as const) })
    );
    const Caller = Flow.Task(
      "Caller",
      { input: Schema.Void, output: Schema.String },
      () =>
        Effect.gen(function* caller() {
          const flaky = yield* Flow.Calls(Flaky);
          return {
            run: flaky().pipe(
              Effect.match({
                onFailure: (failure) => `recovered: ${failure}`,
                onSuccess: (output) => output,
              })
            ),
          };
        })
    );
    const result = await Effect.runPromise(
      Flow.plan(Caller).pipe(Effect.flatMap(Flow.run))
    );
    expect(result).toBe("recovered: agent timed out");
  });

  test("a call that would wait on its caller fails as a cycle", async () => {
    const Ping: Flow.Task<
      "Ping",
      typeof Schema.String,
      typeof Schema.String,
      Flow.CallError | Schema.SchemaError
    > = Flow.Task(
      "Ping",
      { input: Schema.String, output: Schema.String },
      (input) =>
        Effect.gen(function* ping() {
          // oxlint-disable-next-line no-use-before-define -- bodies run lazily, at plan time.
          const pong = yield* Flow.Calls(Pong);
          return { run: pong(input) };
        })
    );
    const Pong = Flow.Task(
      "Pong",
      { input: Schema.String, output: Schema.String },
      (input) =>
        Effect.gen(function* pong() {
          const ping = yield* Flow.Calls(Ping);
          return {
            run: ping(input).pipe(
              Effect.catchTag("CallError", (failure) =>
                Effect.succeed(failure.message)
              )
            ),
          };
        })
    );

    const result = await Effect.runPromise(
      Flow.plan(Ping, "x").pipe(Effect.flatMap(Flow.run))
    );
    expect(result).toBe('Call cycle: Pong("x") -> Ping("x") -> Pong("x")');
  });

  test("calling while planning is a defect", async () => {
    const { Review } = makeAgents({ approveAt: 0 });
    const Eager = Flow.Task(
      "Eager",
      { input: Schema.Void, output: Schema.Void },
      () =>
        Effect.gen(function* eager() {
          const review = yield* Flow.Calls(Review);
          yield* review("too v0");
          return { run: Effect.void };
        })
    );
    const exit = await Effect.runPromiseExit(Flow.plan(Eager));
    expect(Exit.hasDies(exit)).toBe(true);
  });

  test("invalid max fails planning", async () => {
    const { Review } = makeAgents({ approveAt: 0 });
    const Bad = Flow.Task(
      "Bad",
      { input: Schema.Void, output: Schema.Void },
      () =>
        Effect.gen(function* bad() {
          yield* Flow.Calls(Review, { max: -1 });
          return { run: Effect.void };
        })
    );
    const exit = await Effect.runPromiseExit(Flow.plan(Bad));
    expect(exit).toEqual(
      Exit.fail(
        new Flow.PlanError({ message: "Invalid max for calls to Review: -1" })
      )
    );
  });

  test("called Tasks' errors and services are the caller's", async () => {
    class Model extends Context.Service<Model, { readonly name: string }>()(
      "test/Model"
    ) {}
    const Ask = Flow.Task(
      "Ask",
      { input: Schema.String, output: Schema.String },
      (question) =>
        Effect.succeed({
          run: Effect.gen(function* ask() {
            const model = yield* Model;
            if (question === "") {
              return yield* Effect.fail("empty" as const);
            }
            return `${model.name}: ${question}`;
          }),
        })
    );
    const Chat = Flow.Task(
      "Chat",
      { input: Schema.String, output: Schema.String },
      (question) =>
        Effect.gen(function* chat() {
          const ask = yield* Flow.Calls(Ask);
          return { run: ask(question) };
        })
    );

    const program = Flow.plan(Chat, "hi").pipe(Effect.flatMap(Flow.run));
    type Services =
      typeof program extends Effect.Effect<string, unknown, infer R>
        ? R
        : never;
    type Errors =
      typeof program extends Effect.Effect<string, infer E, unknown>
        ? E
        : never;
    const requiresModel: [Services] extends [Model] ? true : false = true;
    const failsEmpty: "empty" extends Errors ? true : false = true;
    expect([requiresModel, failsEmpty]).toEqual([true, true]);

    const result = await Effect.runPromise(
      program.pipe(Effect.provideService(Model, { name: "claude" }))
    );
    expect(result).toBe("claude: hi");
  });
});

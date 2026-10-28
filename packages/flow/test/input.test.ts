import { describe, expect, test } from "bun:test";

import { Effect, Exit, Schema } from "effect";

import { Flow } from "../src/index.ts";

const Refined = Schema.Struct({
  plan: Schema.String,
  status: Schema.Literals(["approved", "exhausted"]),
});

const Decision = Schema.Union([
  Schema.TaggedStruct("Approve", { by: Schema.String }),
  Schema.TaggedStruct("Revise", { notes: Schema.String }),
  Schema.TaggedStruct("Edit", { plan: Schema.String }),
]);

/** Where a person approves, edits, or sends back a plan. */
const ApprovePlan = Flow.Input("ApprovePlan", {
  description: "Approve, edit, or send back the plan.",
  input: Schema.Struct({ goal: Schema.String, plan: Schema.String }),
  output: Decision,
});

const Approval = Schema.Literals(["auto", "human", "human-if-exhausted"]);

/**
 * The plan/review loop stands in as one Task: without notes it gives up,
 * with notes it reaches an approved revision.
 */
const makeTasks = () => {
  const events: string[] = [];

  const Refine = Flow.Task(
    "Refine",
    {
      input: Schema.Struct({
        goal: Schema.String,
        notes: Schema.optional(Schema.String),
      }),
      output: Refined,
    },
    ({ goal, notes }) =>
      Effect.succeed({
        run: Effect.sync(() => {
          events.push(`refine(${notes ?? ""})`);
          return notes === undefined
            ? { plan: `${goal} v0`, status: "exhausted" as const }
            : { plan: `${goal} v1 (${notes})`, status: "approved" as const };
        }),
      })
  );

  const Approve = Flow.Task(
    "Approve",
    {
      input: Schema.Struct({ approval: Approval, goal: Schema.String }),
      output: Schema.Struct({ by: Schema.String, plan: Schema.String }),
    },
    ({ approval, goal }) =>
      Effect.gen(function* approve() {
        const refined = yield* Flow.After(Refine, { goal });
        if (approval === "auto") {
          return {
            run: Effect.map(refined.output, ({ plan }) => ({
              by: "reviewer",
              plan,
            })),
          };
        }
        const ask = yield* Flow.Calls(ApprovePlan);
        const refine = yield* Flow.Calls(Refine);
        return {
          run: Effect.gen(function* approveRun() {
            let current = yield* refined.output;
            if (
              approval === "human-if-exhausted" &&
              current.status === "approved"
            ) {
              return { by: "reviewer", plan: current.plan };
            }
            for (;;) {
              const decision = yield* ask({ goal, plan: current.plan });
              switch (decision._tag) {
                case "Approve": {
                  return { by: decision.by, plan: current.plan };
                }
                case "Edit": {
                  current = { plan: decision.plan, status: current.status };
                  break;
                }
                case "Revise": {
                  current = yield* refine({ goal, notes: decision.notes });
                  break;
                }
                default: {
                  return yield* Effect.die(decision satisfies never);
                }
              }
            }
          }),
        };
      })
  );

  const Implement = Flow.Task(
    "Implement",
    {
      input: Schema.Struct({ approval: Approval, goal: Schema.String }),
      output: Schema.String,
    },
    (input) =>
      Effect.gen(function* implement() {
        const approved = yield* Flow.After(Approve, input);
        return {
          run: Effect.gen(function* implementRun() {
            const { by, plan } = yield* approved.output;
            events.push("implement");
            return `implemented ${plan}, approved by ${by}`;
          }),
        };
      })
  );

  return { Implement, events };
};

const ship = (approval: Schema.Schema.Type<typeof Approval>) => ({
  approval,
  goal: "ship",
});
const askKey = (plan: string) =>
  `ApprovePlan(${JSON.stringify({ goal: "ship", plan })})`;

describe("Flow.Input", () => {
  test("the plan marks where a person may be asked", async () => {
    const { Implement } = makeTasks();
    const human = await Effect.runPromise(
      Flow.plan(Implement, ship("human-if-exhausted"))
    );
    const approve = human.nodes.get(
      `Approve(${JSON.stringify(ship("human-if-exhausted"))})`
    );
    expect(approve?.node.calls).toEqual([
      { kind: "input", max: undefined, name: "ApprovePlan" },
      { kind: "task", max: undefined, name: "Refine" },
    ]);
    expect(Flow.toMermaid(human)).toContain(
      '  call0{{"ApprovePlan#40;…#41;"}}'
    );

    // Auto approval declares no Input, so the plan shows no stop.
    const auto = await Effect.runPromise(Flow.plan(Implement, ship("auto")));
    const calls = [...auto.nodes.values()].flatMap(({ node }) => node.calls);
    expect(calls).toEqual([]);
  });

  test("an Input planned with After is an input node", async () => {
    const Ask = Flow.Task(
      "Ask",
      { input: Schema.Void, output: Schema.String },
      () =>
        Effect.gen(function* ask() {
          const decision = yield* Flow.After(ApprovePlan, {
            goal: "ship",
            plan: "ship v0",
          });
          return { run: Effect.map(decision.output, (d) => d._tag) };
        })
    );
    const plan = await Effect.runPromise(Flow.plan(Ask));
    const input = plan.nodes.get(askKey("ship v0"))?.node;
    expect(input?.kind).toBe("input");
    expect(input?.input).toEqual({ goal: "ship", plan: "ship v0" });
    expect(Flow.toMermaid(plan)).toContain(
      `  0{{"${"ApprovePlan#40;#123;#quot;goal#quot;:#quot;ship#quot;,#quot;plan#quot;:#quot;ship v0#quot;#125;#41;"}"}}`
    );

    const answered = await Effect.runPromise(
      Flow.run(plan, {
        responses: { [askKey("ship v0")]: { _tag: "Approve", by: "dana" } },
      })
    );
    expect(answered).toBe("Approve");
  });

  test("a run stops at an Input with no response", async () => {
    const { Implement, events } = makeTasks();
    const plan = await Effect.runPromise(
      Flow.plan(Implement, ship("human-if-exhausted"))
    );
    const error = await Effect.runPromise(Effect.flip(Flow.run(plan)));

    expect(error).toEqual(
      new Flow.Suspended({
        message: `Waiting for ${askKey("ship v0")}`,
        pending: [
          {
            description: "Approve, edit, or send back the plan.",
            key: askKey("ship v0"),
            name: "ApprovePlan",
            request: { goal: "ship", plan: "ship v0" },
          },
        ],
      })
    );
    expect(events).toEqual(["refine()"]);
  });

  test("each response moves the run to the next stop, then on to Implement", async () => {
    const { Implement, events } = makeTasks();
    const plan = await Effect.runPromise(
      Flow.plan(Implement, ship("human-if-exhausted"))
    );
    const revise = { _tag: "Revise", notes: "add tests" };

    const second = await Effect.runPromise(
      Effect.flip(
        Flow.run(plan, { responses: { [askKey("ship v0")]: revise } })
      )
    );
    expect(second).toMatchObject({
      _tag: "Suspended",
      pending: [{ key: askKey("ship v1 (add tests)") }],
    });

    events.length = 0;
    const result = await Effect.runPromise(
      Flow.run(plan, {
        responses: {
          [askKey("ship v0")]: revise,
          [askKey("ship v1 (add tests)")]: { _tag: "Edit", plan: "ship v2" },
          [askKey("ship v2")]: { _tag: "Approve", by: "dana" },
        },
      })
    );
    expect(result).toBe("implemented ship v2, approved by dana");
    expect(events).toEqual(["refine()", "refine(add tests)", "implement"]);
  });

  test("auto approval runs straight through", async () => {
    const { Implement } = makeTasks();
    const result = await Effect.runPromise(
      Flow.plan(Implement, ship("auto")).pipe(Effect.flatMap(Flow.run))
    );
    expect(result).toBe("implemented ship v0, approved by reviewer");
  });

  test("a response must match the Input's output schema", async () => {
    const { Implement } = makeTasks();
    const plan = await Effect.runPromise(Flow.plan(Implement, ship("human")));
    const exit = await Effect.runPromiseExit(
      Flow.run(plan, {
        responses: { [askKey("ship v0")]: { _tag: "Approve" } },
      })
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("by");
  });

  test("handling an Input's failure does not hide the stop", async () => {
    const Ask = Flow.Task(
      "Ask",
      { input: Schema.Void, output: Schema.String },
      () =>
        Effect.gen(function* ask() {
          const approve = yield* Flow.Calls(ApprovePlan);
          return {
            run: approve({ goal: "ship", plan: "ship v0" }).pipe(
              Effect.match({
                onFailure: () => "assumed approved",
                onSuccess: (decision) => decision._tag,
              })
            ),
          };
        })
    );
    const error = await Effect.runPromise(
      Flow.plan(Ask).pipe(Effect.flatMap(Flow.run), Effect.flip)
    );
    expect(error._tag).toBe("Suspended");
  });
});

import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { Flow } from "../src/index.ts";

const Goal = Schema.String;
const Packages = Schema.Array(Schema.String);

/** Every concept in one plan; the Tasks only declare, so none of them run. */
const makeShip = () => {
  const InstallDeps = Flow.Task(
    "InstallDeps",
    {
      description: "Installs packages.",
      input: Packages,
      labels: ["setup"],
      output: Schema.Finite,
    },
    (packages) => Effect.succeed({ run: Effect.succeed(packages.length) })
  );

  // Two Tasks after the same InstallDeps node: a diamond.
  const Lint = Flow.Task(
    "Lint",
    { input: Packages, labels: ["check"], output: Schema.Boolean },
    (packages) =>
      Effect.gen(function* lint() {
        yield* Flow.After(InstallDeps, packages);
        return { run: Effect.succeed(true) };
      })
  );
  const RunTests = Flow.Task(
    "RunTests",
    { input: Packages, labels: ["check"], output: Schema.Boolean },
    (packages) =>
      Effect.gen(function* runTests() {
        yield* Flow.After(InstallDeps, packages);
        // The same Task with another input is another node.
        yield* Flow.After(InstallDeps, ["vitest"]);
        return { run: Effect.succeed(true) };
      })
  );

  const GatherContext = Flow.Task(
    "GatherContext",
    { input: Goal, output: Schema.String },
    (goal) => Effect.succeed({ run: Effect.succeed(goal) })
  );
  const Draft = Flow.Task(
    "Draft",
    { input: Goal, output: Schema.String },
    (goal) => Effect.succeed({ run: Effect.succeed(goal) })
  );
  const Review = Flow.Task(
    "Review",
    { input: Schema.String, output: Schema.Boolean },
    () => Effect.succeed({ run: Effect.succeed(true) })
  );

  // Declared calls, capped: the agent loop.
  const Refine = Flow.Task(
    "Refine",
    {
      description: "Drafts and reviews a plan until the reviewer approves.",
      input: Goal,
      labels: ["agents"],
      output: Schema.String,
    },
    (goal) =>
      Effect.gen(function* refine() {
        yield* Flow.After(GatherContext, goal);
        yield* Flow.Calls(Draft, { max: 3 });
        yield* Flow.Calls(Review, { max: 3 });
        return { run: Effect.succeed(goal) };
      })
  );

  // An Input reached through a declared call.
  const ApprovePlan = Flow.Input("ApprovePlan", {
    description: "A person approves or revises the plan.",
    input: Schema.Struct({ goal: Goal, plan: Schema.String }),
    labels: ["human"],
    output: Schema.Boolean,
  });
  const Approve = Flow.Task(
    "Approve",
    { input: Goal, output: Schema.String },
    (goal) =>
      Effect.gen(function* approve() {
        yield* Flow.After(Refine, goal);
        yield* Flow.Calls(ApprovePlan);
        // An uncapped call: revisions go back through the agent loop.
        yield* Flow.Calls(Refine);
        return { run: Effect.succeed(goal) };
      })
  );

  const Implement = Flow.Task(
    "Implement",
    { input: Goal, labels: ["agents"], output: Schema.String },
    (goal) =>
      Effect.gen(function* implement() {
        yield* Flow.After(Approve, goal);
        return { run: Effect.succeed(goal) };
      })
  );

  // An Input planned with After: its request is known at plan time.
  const ConfirmRelease = Flow.Input("ConfirmRelease", {
    description: "A person confirms the release.",
    input: Goal,
    labels: ["human"],
    output: Schema.Boolean,
  });

  const Ship = Flow.Task(
    "Ship",
    {
      description: "Plans, implements, checks, and releases a change.",
      input: Goal,
      labels: ["release"],
      output: Schema.String,
    },
    (goal) =>
      Effect.gen(function* ship() {
        const packages = ["effect", "typescript"];
        yield* Flow.After(Implement, goal);
        yield* Flow.After(Lint, packages);
        yield* Flow.After(RunTests, packages);
        yield* Flow.After(ConfirmRelease, goal);
        return { run: Effect.succeed(goal) };
      })
  );

  return Ship;
};

describe("plan snapshot", () => {
  test("a plan with every concept", async () => {
    const plan = await Effect.runPromise(Flow.plan(makeShip(), "ship"));

    expect(Flow.toMermaid(plan)).toMatchSnapshot("mermaid");
    expect(
      plan.order.map((key) => {
        const entry = plan.nodes.get(key);
        return {
          calls: entry?.node.calls,
          dependencies: entry?.dependencies,
          description: entry?.node.description,
          input: entry?.node.input,
          key,
          kind: entry?.node.kind,
          labels: entry?.node.labels,
        };
      })
    ).toMatchSnapshot("nodes");
  });
});

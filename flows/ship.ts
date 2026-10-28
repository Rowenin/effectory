/**
 * Plan, review and implement a change, with a person approving the plan.
 * The agents are fakes, so the flow runs anywhere: the reviewer asks for
 * tests until the plan mentions them.
 */
import { Flow } from "@effectory/flow";
import { Context, Effect, Layer, Schema } from "effect";

export class Agents extends Context.Service<
  Agents,
  {
    readonly plan: (goal: string, notes?: string) => Effect.Effect<string>;
    readonly review: (
      plan: string
    ) => Effect.Effect<{ readonly approved: boolean; readonly notes: string }>;
    readonly implement: (plan: string) => Effect.Effect<string>;
  }
>()("effectory/flows/Agents") {}

export const AgentsFake = Layer.succeed(Agents)({
  implement: (plan) => Effect.succeed(`Implemented: ${plan}`),
  plan: (goal, notes) =>
    Effect.succeed(notes ? `${goal}, ${notes}` : `${goal}, first draft`),
  review: (plan) =>
    Effect.succeed(
      plan.includes("tests")
        ? { approved: true, notes: "Looks good" }
        : { approved: false, notes: "add tests" }
    ),
});

const Goal = Schema.String;

export const Draft = Flow.Task(
  "Draft",
  {
    description: "A planning agent drafts a plan, using notes if given.",
    input: Schema.Struct({ goal: Goal, notes: Schema.optional(Schema.String) }),
    labels: ["agent"],
    output: Schema.String,
  },
  ({ goal, notes }) =>
    Effect.succeed({
      run: Effect.flatMap(Agents, (agents) => agents.plan(goal, notes)),
    })
);

const Verdict = Schema.Struct({
  approved: Schema.Boolean,
  notes: Schema.String,
});

export const Review = Flow.Task(
  "Review",
  {
    description: "A reviewing agent approves a plan or sends notes back.",
    input: Schema.String,
    labels: ["agent"],
    output: Verdict,
  },
  (plan) =>
    Effect.succeed({
      run: Effect.flatMap(Agents, (agents) => agents.review(plan)),
    })
);

export const Refine = Flow.Task(
  "Refine",
  {
    description:
      "Drafts and reviews until the reviewer approves, at most 3 rounds.",
    input: Goal,
    labels: ["agent", "loop"],
    output: Schema.String,
  },
  (goal) =>
    Effect.gen(function* refine() {
      const draft = yield* Flow.Calls(Draft, { max: 3 });
      const review = yield* Flow.Calls(Review, { max: 3 });
      return {
        run: Effect.gen(function* refineRun() {
          let plan = yield* draft({ goal });
          for (let round = 1; round < 3; round += 1) {
            const verdict = yield* review(plan);
            if (verdict.approved) {
              break;
            }
            plan = yield* draft({ goal, notes: verdict.notes });
          }
          return plan;
        }),
      };
    })
);

const Decision = Schema.Union([
  Schema.TaggedStruct("Approve", { by: Schema.String }),
  Schema.TaggedStruct("Revise", { notes: Schema.String }),
]);

export const ApprovePlan = Flow.Input("ApprovePlan", {
  description:
    'Approve the plan with {"_tag":"Approve","by":"<name>"}, or send it back with {"_tag":"Revise","notes":"<notes>"}.',
  input: Schema.Struct({ goal: Goal, plan: Schema.String }),
  labels: ["human"],
  output: Decision,
});

export const Approve = Flow.Task(
  "Approve",
  {
    description: "A person approves the refined plan, revising it as needed.",
    input: Goal,
    labels: ["human", "loop"],
    output: Schema.String,
  },
  (goal) =>
    Effect.gen(function* approve() {
      const refined = yield* Flow.After(Refine, goal);
      const ask = yield* Flow.Calls(ApprovePlan);
      const draft = yield* Flow.Calls(Draft);
      return {
        run: Effect.gen(function* approveRun() {
          let plan = yield* refined.output;
          for (;;) {
            const decision = yield* ask({ goal, plan });
            if (decision._tag === "Approve") {
              return plan;
            }
            plan = yield* draft({ goal, notes: decision.notes });
          }
        }),
      };
    })
);

export const Implement = Flow.Task(
  "Implement",
  {
    description: "Plans, gets approval, then implements a change.",
    input: Goal,
    labels: ["entry", "agent"],
    output: Schema.String,
  },
  (goal) =>
    Effect.gen(function* implement() {
      const approved = yield* Flow.After(Approve, goal);
      return {
        run: Effect.gen(function* implementRun() {
          const agents = yield* Agents;
          return yield* agents.implement(yield* approved.output);
        }),
      };
    })
);

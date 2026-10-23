import { describe, expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";

import * as Action from "../src/action.ts";
import { Approve } from "../src/approve.ts";
import * as Engine from "../src/engine.ts";
import * as State from "../src/state.ts";
import * as Workflow from "../src/workflow.ts";

const options = { collection: "test", revision: "r1" };
const layer = Engine.layer.pipe(Layer.provideMerge(State.memory));
const run = <A, E>(effect: Effect.Effect<A, E, Engine.Engine | State.State>) =>
  Effect.runPromise(Effect.provide(effect, layer));

const Echo = Action.make("Echo", {
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.String,
  run: ({ value }) => Effect.succeed(value),
});

const workflow = Workflow.make(
  "deploy",
  { description: "", input: Schema.Struct({}) },
  Effect.fn(function* body() {
    const diff = yield* Echo("diff", { value: "+1 -1" });
    const decision = yield* Approve("ship", {
      review: { diff },
      title: "Ship it?",
    });
    const shipped = yield* Echo(
      "shipped",
      { value: "live" },
      { dependsOn: [decision] }
    );
    yield* Echo("independent", { value: "done" });
    return { decision, shipped };
  })
);

const statusOf = (summary: Engine.RunSummary, fqn: string) =>
  summary.nodes.find((node) => node.fqn === fqn)?.status;

const suspend = Effect.gen(function* suspend() {
  const engine = yield* Engine.Engine;
  const state = yield* State.State;
  const summary = yield* engine.run(workflow, {}, options);
  const approvals = yield* state.listApprovals({ runId: summary.run.id });
  return { approvals, engine, summary };
});

describe("Approve", () => {
  test("suspends dependents while independent branches finish", async () => {
    const { approvals, summary } = await run(suspend);
    expect(summary.run.status).toBe("suspended");
    expect(statusOf(summary, "deploy/ship")).toBe("suspended");
    expect(statusOf(summary, "deploy/shipped")).toBe("pending");
    expect(statusOf(summary, "deploy/independent")).toBe("succeeded");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      fqn: "deploy/ship",
      id: Approve.approvalId(summary.run.id, "deploy/ship"),
      review: { diff: "+1 -1" },
      status: "pending",
      title: "Ship it?",
    });
  });

  test("approve then resume runs dependents and succeeds", async () => {
    const { first, second } = await run(
      Effect.gen(function* approve() {
        const { engine, summary } = yield* suspend;
        const id = Approve.approvalId(summary.run.id, "deploy/ship");
        // Resuming before a decision stays suspended.
        const waiting = yield* engine.resume(workflow, summary.run.id, options);
        expect(waiting.run.status).toBe("suspended");
        yield* Approve.decide(id, { approved: true, by: "dana", note: "lgtm" });
        const resumed = yield* engine.resume(workflow, summary.run.id, options);
        return { first: summary, second: resumed };
      })
    );
    expect(first.run.status).toBe("suspended");
    expect(second.run.status).toBe("succeeded");
    expect(second.run.result).toEqual({
      decision: { approved: true, decidedBy: "dana", note: "lgtm" },
      shipped: "live",
    });
    expect(statusOf(second, "deploy/shipped")).toBe("succeeded");
  });

  test("reject then resume fails the run", async () => {
    const resumed = await run(
      Effect.gen(function* reject() {
        const { engine, summary } = yield* suspend;
        yield* Approve.decide(
          Approve.approvalId(summary.run.id, "deploy/ship"),
          { approved: false, by: "dana", note: "not today" }
        );
        return yield* engine.resume(workflow, summary.run.id, options);
      })
    );
    expect(resumed.run.status).toBe("failed");
    expect(
      resumed.nodes.find((node) => node.fqn === "deploy/ship")?.error
    ).toEqual({
      message: "Ship it? was rejected by dana: not today",
      tag: "ApprovalRejected",
    });
    expect(statusOf(resumed, "deploy/shipped")).toBe("skipped");
  });

  test("decide refuses unknown and already decided approvals", async () => {
    const { missing, twice } = await run(
      Effect.gen(function* refuse() {
        const { summary } = yield* suspend;
        const id = Approve.approvalId(summary.run.id, "deploy/ship");
        yield* Approve.decide(id, { approved: true });
        return {
          missing: yield* Effect.flip(
            Approve.decide("nope", { approved: true })
          ),
          twice: yield* Effect.flip(Approve.decide(id, { approved: false })),
        };
      })
    );
    expect(missing._tag).toBe("ApprovalNotFound");
    expect(twice._tag).toBe("ApprovalNotPending");
  });

  test("when: false skips without opening an approval and dependents still run", async () => {
    const skipped = Workflow.make(
      "maybe",
      { description: "", input: Schema.Struct({}) },
      Effect.fn(function* body() {
        const decision = yield* Approve("ship", {
          title: "Ship?",
          when: false,
        });
        yield* Echo("after", { value: "x" }, { dependsOn: [decision] });
      })
    );
    const { approvals, summary } = await run(
      Effect.gen(function* skip() {
        const engine = yield* Engine.Engine;
        const state = yield* State.State;
        const ran = yield* engine.run(skipped, {}, options);
        return {
          approvals: yield* state.listApprovals({ runId: ran.run.id }),
          summary: ran,
        };
      })
    );
    expect(summary.run.status).toBe("succeeded");
    expect(statusOf(summary, "maybe/ship")).toBe("skipped");
    expect(statusOf(summary, "maybe/after")).toBe("succeeded");
    expect(approvals).toEqual([]);
  });
});

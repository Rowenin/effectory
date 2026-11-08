import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { terminal } from "@effectory/runtime/protocol";
import {
  Application,
  Extension,
  Ref,
  Task,
  Workflow,
  WorkflowPatch,
} from "@offtree/effectory-sdk";
import { Effect, Layer, Schema } from "effect";

import { catalogLayer } from "../src/catalog.ts";
import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { Runner } from "../src/runner.ts";

async function withHost<A, E>(
  app: Application.Application<never>,
  body: Effect.Effect<A, E, typeof Runner.Service | typeof HostStore.Service>
) {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-patches-"));
  const catalog = Layer.unwrap(
    Effect.map(Application.Registry, (registry) =>
      catalogLayer("revision", new Map([["revision", registry]]))
    )
  ).pipe(Layer.provide(app.layer));
  try {
    return await Effect.runPromise(
      body.pipe(
        Effect.provide(
          hostLayer({
            blobs: path.join(directory, "blobs"),
            catalog,
            database: path.join(directory, "state.sqlite"),
          })
        )
      )
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
const waits = (runId: string, count: number) =>
  Effect.gen(function* () {
    const store = yield* HostStore;
    for (let index = 0; index < 300; index += 1) {
      const open = (yield* store.listWaits(runId)).filter(
        (wait) => wait.status === "Open"
      );
      if (open.length === count) {
        return open;
      }
      const run = yield* store.getRun(runId);
      if (terminal.has(run.status)) {
        return yield* Effect.die(
          `Run ended before patch waits opened: ${JSON.stringify(run)}`
        );
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(
      `Patch waits did not open: ${JSON.stringify({ events: yield* store.events(runId), run: yield* store.getRun(runId), waits: yield* store.listWaits(runId) })}`
    );
  });
const settled = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* HostStore;
    for (let index = 0; index < 500; index += 1) {
      const run = yield* store.getRun(runId);
      if (terminal.has(run.status) || run.status === "NeedsAttention") {
        return run;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die("Patched run did not settle");
  });
const binding = (
  id: string,
  use: string,
  workflow: string,
  at: Extension.Binding["at"]
): Extension.Binding => ({
  at,
  id,
  use,
  workflow: { id: workflow, version: 1 },
});

test.each(["approve", "reject"] as const)(
  "a selected replacement runs only after every patch barrier: %s",
  async (operation) => {
    const calls: string[] = [];
    const Input = Schema.Struct({ name: Schema.String });
    const Base = Task.make(
      {
        error: Schema.Never,
        id: "publish",
        input: Input,
        replay: "manual",
        success: Schema.String,
        version: 1,
      },
      ({ name }) =>
        Effect.sync(() => {
          calls.push(`base/${name}`);
          return name;
        })
    );
    const Provider = Task.implementation(
      { id: "acme/tools/provider", target: Base },
      ({ name }) =>
        Effect.sync(() => {
          calls.push(`provider/${name}`);
          return name;
        })
    );
    const Inspect = Task.make(
      {
        error: Schema.Never,
        id: "acme/tools/inspect",
        input: Schema.String,
        replay: "manual",
        success: Input,
        version: 1,
      },
      (name) =>
        Effect.sync(() => {
          calls.push("inspect");
          return { name };
        })
    );
    const Review = WorkflowPatch.make(
      { id: "acme/tools/review", target: Base },
      (input) =>
        Effect.gen(function* () {
          const graph = yield* Workflow.Builder;
          yield* graph.approval("review", {
            context: input,
            prompt: "Publish?",
            timeout: "1 minute",
          });
        })
    );
    const After = WorkflowPatch.make(
      { id: "acme/tools/after", target: Base },
      (input) =>
        Effect.gen(function* () {
          const graph = yield* Workflow.Builder;
          yield* graph.requestInput("confirm", {
            context: input,
            prompt: "Confirm",
            schema: Schema.String,
            timeout: "1 minute",
          });
        })
    );
    const Tools = Extension.make({
      id: "acme/tools",
      implementations: [Provider],
      patches: [Review, After],
      tasks: { Inspect },
      version: "1.0.0",
    });
    const Flow = Workflow.make(
      {
        error: Schema.Never,
        id: "publish-flow",
        input: Schema.String,
        success: Schema.String,
        version: 1,
      },
      Effect.gen(function* () {
        const graph = yield* Workflow.Builder;
        const input = yield* graph.task(
          "inspect",
          Tools.tasks.Inspect,
          yield* graph.input(Schema.String)
        );
        return yield* graph.task("publish", Base, input);
      })
    );
    const app = Application.make({
      extensions: [
        Extension.use(Tools, {
          implementations: [Provider.providerId],
          patches: [
            {
              ...binding("second", After.id, Flow.id, ["publish"]),
              after: ["first"],
            },
            binding("first", Review.id, Flow.id, ["publish"]),
          ],
        }),
      ],
      tasks: [Base],
      workflows: [Flow],
    });
    return await withHost(
      app,
      Effect.gen(function* () {
        const runner = yield* Runner;
        const store = yield* HostStore;
        const run = yield* runner.submit(
          {
            input: "Ada",
            kind: "workflow",
            requestKey: operation,
            targetId: Flow.id,
          },
          "owner"
        );
        const [review] = yield* waits(run.runId, 1);
        if (!review) {
          return yield* Effect.die("Missing review");
        }
        expect(review.context).toEqual({ name: "Ada" });
        expect(JSON.parse(review.nodeId)).toEqual([
          "publish",
          "$patch",
          "first",
          "review",
        ]);
        expect(calls).toEqual(["inspect"]);
        yield* runner.settle(
          { operation, requestKey: "review", waitId: review.waitId },
          "owner"
        );
        if (operation === "reject") {
          expect((yield* settled(run.runId)).status).toBe("Rejected");
          expect(calls).toEqual(["inspect"]);
          expect((yield* store.listWaits(run.runId)).length).toBe(1);
          return;
        }
        const [confirmation] = yield* waits(run.runId, 1);
        if (!confirmation) {
          return yield* Effect.die("Missing confirmation");
        }
        expect(confirmation.kind).toBe("input");
        expect(calls).toEqual(["inspect"]);
        const invalid = yield* runner
          .settle(
            {
              input: 123,
              operation: "respond",
              requestKey: "invalid",
              waitId: confirmation.waitId,
            },
            "owner"
          )
          .pipe(Effect.result);
        expect(invalid._tag).toBe("Failure");
        expect((yield* store.getWait(confirmation.waitId)).status).toBe("Open");
        yield* runner.settle(
          {
            input: "yes",
            operation: "respond",
            requestKey: "confirm",
            waitId: confirmation.waitId,
          },
          "owner"
        );
        expect((yield* settled(run.runId)).result).toBe("Ada");
        expect(calls).toEqual(["inspect", "provider/Ada"]);
      })
    );
  },
  15_000
);

test("patches in inactive branches stay closed and item patches have stable independent paths", async () => {
  const calls: string[] = [];
  const Target = Task.make(
    {
      error: Schema.Never,
      id: "target",
      input: Schema.String,
      replay: "manual",
      success: Schema.String,
      version: 1,
    },
    (value) =>
      Effect.sync(() => {
        calls.push(value);
        return value;
      })
  );
  const Patch = WorkflowPatch.make(
    { id: "acme/review/before", target: Target },
    (input) =>
      Effect.gen(function* () {
        const graph = yield* Workflow.Builder;
        yield* graph.approval("review", {
          context: input,
          prompt: "Proceed?",
          timeout: "1 minute",
        });
      })
  );
  const Reviews = Extension.make({
    id: "acme/review",
    patches: [Patch],
    version: "1.0.0",
  });
  const Input = Schema.Struct({
    enabled: Schema.Boolean,
    items: Schema.Array(Schema.String),
  });
  const Output = Schema.Array(Schema.String);
  const Flow = Workflow.make(
    {
      error: Schema.Never,
      id: "scoped",
      input: Input,
      success: Output,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      const input = yield* graph.input(Input);
      return yield* graph.branch("mode", Ref.field(input, "enabled"), {
        onFalse: Effect.succeed([]),
        onTrue: Effect.gen(function* () {
          const child = yield* Workflow.Builder;
          // oxlint-disable-next-line unicorn/no-array-for-each -- Durable graph operator.
          return yield* child.forEach(
            "items",
            Ref.field(input, "items"),
            {
              concurrency: 2,
              item: Schema.String,
              key: (item) => item,
              maxItems: 10,
              success: Schema.String,
            },
            (item) =>
              Effect.gen(function* () {
                const iteration = yield* Workflow.Builder;
                return yield* iteration.task("target", Target, item);
              })
          );
        }),
        success: Output,
      });
    })
  );
  const app = Application.make({
    extensions: [
      Extension.use(Reviews, {
        patches: [
          binding("review", Patch.id, Flow.id, [
            "mode",
            { branch: "onTrue" },
            "items",
            { item: true },
            "target",
          ]),
        ],
      }),
    ],
    tasks: [Target],
    workflows: [Flow],
  });
  return await withHost(
    app,
    Effect.gen(function* () {
      const runner = yield* Runner;
      const store = yield* HostStore;
      const inactive = yield* runner.submit(
        {
          input: { enabled: false, items: ["a", "b"] },
          kind: "workflow",
          requestKey: "inactive",
          targetId: Flow.id,
        },
        "owner"
      );
      expect((yield* settled(inactive.runId)).result).toEqual([]);
      expect(yield* store.listWaits(inactive.runId)).toEqual([]);
      expect(calls).toEqual([]);
      const active = yield* runner.submit(
        {
          input: { enabled: true, items: ["a", "b"] },
          kind: "workflow",
          requestKey: "active",
          targetId: Flow.id,
        },
        "owner"
      );
      const reviews = yield* waits(active.runId, 2);
      const nodePaths = yield* Effect.forEach(
        reviews.map((wait) => wait.nodeId).toSorted(),
        (nodeId) =>
          Schema.decodeEffect(
            Schema.fromJsonString(Schema.Array(Schema.String))
          )(nodeId)
      );
      expect(nodePaths).toEqual([
        ["mode", "true", "items", "a", "target", "$patch", "review", "review"],
        ["mode", "true", "items", "b", "target", "$patch", "review", "review"],
      ]);
      expect(calls).toEqual([]);
      yield* Effect.forEach(reviews, (wait) =>
        runner.settle(
          {
            operation: "approve",
            requestKey: wait.waitId,
            waitId: wait.waitId,
          },
          "owner"
        )
      );
      expect((yield* settled(active.runId)).result).toEqual(["a", "b"]);
      expect(calls.toSorted()).toEqual(["a", "b"]);
    })
  );
}, 15_000);

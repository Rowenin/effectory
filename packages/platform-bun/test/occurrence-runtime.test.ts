import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { terminal } from "@effectory/runtime/protocol";
import {
  Application,
  Artifact,
  Extension,
  Task,
  Workflow,
  WorkflowPatch,
  WorkflowSchedule,
} from "@offtree/effectory-sdk";
import { Effect, Layer, Schema } from "effect";
import type { WorkflowEngine } from "effect/workflow/WorkflowEngine";

import { catalogLayer } from "../src/catalog.ts";
import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { Runner } from "../src/runner.ts";

async function withHost<A, E>(
  app: Application.Application<never>,
  body: Effect.Effect<
    A,
    E,
    typeof Runner.Service | typeof HostStore.Service | WorkflowEngine
  >
) {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-operators-"));
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
const settle = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* HostStore;
    for (let index = 0; index < 500; index += 1) {
      const run = yield* store.getRun(runId);
      if (terminal.has(run.status) || run.status === "NeedsAttention") {
        return run;
      }
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die("Operator run did not settle");
  });

test("scheduled occurrence survives retries, replacement, patches, branches and linked fan-out; manual runs omit it", async () => {
  const seen: {
    runId: string;
    occurrence: typeof WorkflowSchedule.Occurrence.Type | undefined;
    attempt: number;
    source: string;
  }[] = [];
  const publications: Artifact.Reference[] = [];
  const capture = (
    context: Pick<Task.RuntimeContext, "occurrence" | "runId" | "attempt">,
    source: string
  ) => {
    const { occurrence } = context;
    seen.push({
      attempt: context.attempt,
      occurrence,
      runId: context.runId,
      source,
    });
    if (occurrence === undefined) {
      expect(context).not.toHaveProperty("occurrence");
    } else {
      expect(Object.isFrozen(occurrence)).toBe(true);
      expect(Reflect.set(occurrence, "generation", 999)).toBe(false);
      // Replacing the local property must also leave other attempts untouched.
      Reflect.set(context, "occurrence", { ...occurrence, generation: 999 });
    }
    return occurrence ?? null;
  };
  const Result = Schema.NullOr(WorkflowSchedule.Occurrence);
  const Retry = Schema.TaggedStruct("Again", {});
  const Report = Artifact.make({
    id: "occurrence-report",
    schema: WorkflowSchedule.Occurrence,
    version: 1,
  });
  const Base = Task.make(
    {
      error: Retry,
      id: "read",
      input: Schema.String,
      outputs: { report: Report },
      replay: "idempotent",
      success: Result,
      version: 1,
    },
    () => Effect.die("replacement must be selected")
  );
  const Provider = Task.implementation(
    { id: "acme/context/read", target: Base },
    (_, context) =>
      Effect.gen(function* () {
        const occurrence = capture(context, "replacement");
        if (context.attempt === 1) {
          return yield* Effect.fail({ _tag: "Again" as const });
        }
        if (occurrence) {
          const key = `slot-${Date.parse(occurrence.scheduledFor)}`;
          expect(context.key(key)).toContain(key);
          publications.push(
            yield* context.publish("report", occurrence, { key })
          );
        }
        return occurrence;
      })
  );
  const Inspect = Task.make(
    {
      error: Schema.Never,
      id: "acme/context/inspect",
      input: Schema.String,
      replay: "idempotent",
      success: Result,
      version: 1,
    },
    (_, context) => Effect.sync(() => capture(context, "patch"))
  );
  const Patch = WorkflowPatch.make(
    { id: "acme/context/patch", target: Base },
    (input) =>
      Effect.gen(function* () {
        const graph = yield* Workflow.Builder;
        yield* graph.task("inspect", Inspect, input);
      })
  );
  const Child = Workflow.make(
    {
      error: Retry,
      id: "child",
      input: Schema.String,
      success: Result,
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      return yield* graph.task(
        "read",
        Base,
        yield* graph.input(Schema.String),
        { retry: { attempts: 2, delay: "10 millis", when: ["Again"] } }
      );
    })
  );
  const Items = Schema.Array(Schema.String);
  const Parent = Workflow.make(
    {
      error: Retry,
      id: "parent",
      input: Items,
      success: Schema.Array(Result),
      version: 1,
    },
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      const items = yield* graph.input(Items);
      const selected = yield* graph.map(
        "select",
        { input: items, success: Schema.Boolean },
        () => true
      );
      return yield* graph.branch("selected", selected, {
        onFalse: Effect.gen(function* () {
          const branch = yield* Workflow.Builder;
          return yield* branch.map(
            "empty",
            { input: items, success: Schema.Array(Result) },
            () => []
          );
        }),
        onTrue: Effect.gen(function* () {
          const branch = yield* Workflow.Builder;
          // oxlint-disable-next-line unicorn/no-array-for-each -- Declares a durable graph operator.
          return yield* branch.forEach(
            "items",
            items,
            {
              concurrency: 2,
              item: Schema.String,
              key: (item) => item,
              maxItems: 2,
              success: Result,
            },
            (item) =>
              Effect.gen(function* () {
                const iteration = yield* Workflow.Builder;
                return yield* iteration.workflow("child", Child, item);
              })
          );
        }),
        success: Schema.Array(Result),
      });
    })
  );
  const Tools = Extension.make({
    id: "acme/context",
    implementations: [Provider],
    patches: [Patch],
    tasks: { Inspect },
    version: "1.0.0",
  });
  const schedule = WorkflowSchedule.make({
    cron: "* * * * *",
    id: "read-minute",
    input: ["one", "two"],
    workflow: Parent,
  });
  const app = Application.make({
    extensions: [
      Extension.use(Tools, {
        implementations: [Provider.providerId],
        patches: [
          {
            at: ["read"],
            id: "inspect",
            use: Patch.id,
            workflow: { id: Child.id, version: 1 },
          },
        ],
      }),
    ],
    schedules: [schedule],
    tasks: [Base],
  });
  return await withHost(
    app,
    Effect.gen(function* () {
      const store = yield* HostStore;
      const runner = yield* Runner;
      const slot = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
      yield* store.scheduleTick(schedule.id, slot, false);
      const [run] = yield* store.listRuns();
      if (!run?.schedule) {
        return yield* Effect.die("no occurrence admitted");
      }
      yield* store.scheduleMutation(
        { requestKey: "pause", scheduleId: schedule.id },
        true,
        "owner",
        slot
      );
      expect((yield* settle(run.runId)).status).toBe("Succeeded");
      const scheduled = seen.filter((item) => item.runId === run.runId);
      expect(scheduled.filter((item) => item.source === "patch")).toHaveLength(
        2
      );
      expect(
        scheduled.filter((item) => item.source === "replacement")
      ).toHaveLength(4);
      expect(new Set(scheduled.map((item) => item.occurrence)).size).toBe(6);
      for (const item of scheduled) {
        expect(item.occurrence).toEqual(run.schedule);
      }
      expect((yield* store.getRun(run.runId)).schedule).toEqual(run.schedule);
      expect(publications).toHaveLength(2);
      expect(publications[0]?.artifactId).toBe(publications[1]?.artifactId);
      expect(
        publications.map((item) => item.version).toSorted((a, b) => a - b)
      ).toEqual([1, 2]);
      for (const request of [
        {
          input: ["manual"],
          kind: "workflow" as const,
          requestKey: "manual-flow",
          targetId: Parent.id,
        },
        {
          input: "manual",
          kind: "task" as const,
          requestKey: "manual-task",
          targetId: Inspect.id,
        },
      ]) {
        const manual = yield* runner.submit(request, "owner");
        expect((yield* settle(manual.runId)).status).toBe("Succeeded");
        const attempts = seen.filter((item) => item.runId === manual.runId);
        expect(attempts.length).toBeGreaterThan(0);
        for (const item of attempts) {
          expect(item.occurrence).toBeUndefined();
        }
      }
    })
  );
}, 30_000);

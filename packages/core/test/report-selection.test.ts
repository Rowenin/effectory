import { expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { DefinitionError } from "../src/errors.ts";
import {
  Application,
  Extension,
  Ref,
  Report,
  Task,
  Tag,
  Workflow,
  WorkflowPatch,
  WorkflowSchedule,
} from "../src/index.ts";
import {
  normalizeSelection,
  SelectionDecision,
} from "../src/report-selection-schema.ts";
import { selectReports } from "../src/report-selection.ts";

const Category = Tag.make("category", Schema.Literals(["cost", "audit"]));
const Source = Task.make(
  {
    error: Schema.Never,
    id: "source",
    input: Schema.String,
    replay: "idempotent",
    success: Schema.String,
    version: 1,
  },
  Effect.succeed
);
const Reporter = Task.make(
  {
    error: Schema.Never,
    id: "reporter",
    input: Report.Source,
    replay: "idempotent",
    success: Report.result(Schema.String),
    version: 1,
  },
  () => Effect.succeed({ data: "ok", markdown: "ok" })
);
const makeReport = (id: string, tags: Tag.Input, required = false) =>
  Report.make({
    id,
    required,
    scope: "invocation",
    tags,
    target: Source,
    task: Reporter,
  });
const Cost = makeReport("cost", [Category("cost")]);
const Audit = makeReport("audit", [Category("audit")], true);
const Finance = makeReport("finance", { category: "cost", team: "finance" });
const Flow = Workflow.make(
  {
    error: Schema.Never,
    id: "flow",
    input: Schema.String,
    success: Schema.String,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    return yield* graph.task(
      "source",
      Source,
      yield* graph.input(Schema.String)
    );
  })
);
const registry = () =>
  Effect.runPromise(
    Application.Registry.pipe(
      Effect.provide(
        Application.make({
          reports: [Cost, Audit, Finance],
          tasks: [Source, Reporter],
          workflows: [Flow],
        }).layer
      )
    )
  );

test.each([
  [{}, ["audit", "cost", "finance"]],
  [{ skipAll: true }, ["audit"]],
  [{ skip: ["audit"] }, ["audit", "cost", "finance"]],
  [{ only: ["cost"], skip: ["cost"] }, ["audit"]],
  [{ onlyTags: { category: "cost" } }, ["audit", "cost", "finance"]],
  [{ only: ["cost"], onlyTags: { team: "finance" } }, ["audit"]],
  [{ skipTags: { category: "cost", team: "finance" } }, ["audit", "cost"]],
  [{ onlyTags: { category: "COST" } }, ["audit"]],
] as const)("selection precedence %j", async (selection, selected) => {
  const result = selectReports(
    await registry(),
    "workflow",
    Flow.id,
    selection
  );
  expect(result.decision.selected).toEqual(selected);
  expect(result.decision.required).toEqual(["audit"]);
  expect(
    result.decision.selected.length + result.decision.excluded.length
  ).toBe(3);
});

test("metadata and schedule selectors are captured and validated synchronously", async () => {
  const raw = { category: "cost" };
  const report = makeReport("copy", raw);
  raw.category = "changed";
  expect(report.tags).toEqual({ category: "cost" });
  expect(Object.isFrozen(report.tags)).toBe(true);
  expect(() => makeReport("bare", [Category] as never)).toThrow(
    DefinitionError
  );
  expect(() =>
    makeReport("duplicate", [Category("cost"), Category("audit")])
  ).toThrow(DefinitionError);
  expect(() => makeReport("foreign", [{}] as never)).toThrow(DefinitionError);
  expect(() => makeReport("too-big", { label: "x".repeat(257) })).toThrow(
    DefinitionError
  );
  expect(() =>
    Report.make({
      id: "bad",
      required: undefined,
      scope: "run",
      target: Source,
      task: Reporter,
    } as never)
  ).toThrow(DefinitionError);
  const only = ["cost"];
  const schedule = WorkflowSchedule.make({
    cron: "0 0 * * *",
    id: "daily",
    input: "x",
    reportSelection: { only, skipTags: [Category("audit")] },
    workflow: Flow,
  });
  only.push("unknown");
  expect(schedule.reportSelection).toEqual({
    only: ["cost"],
    skipTags: { category: "audit" },
  });
  expect(Object.isFrozen(schedule.reportSelection.only)).toBe(true);
  expect(() =>
    WorkflowSchedule.make({
      cron: "0 0 * * *",
      id: "invalid",
      input: "x",
      reportSelection: undefined,
      workflow: Flow,
    } as never)
  ).toThrow(DefinitionError);
  const invalid = WorkflowSchedule.make({
    cron: "0 0 * * *",
    id: "unknown",
    input: "x",
    reportSelection: { only: ["unknown"] },
    workflow: Flow,
  });
  await expect(
    Effect.runPromise(
      Application.Registry.pipe(
        Effect.provide(
          Application.make({
            reports: [Cost],
            schedules: [invalid],
            tasks: [Source, Reporter],
          }).layer
        )
      )
    )
  ).rejects.toThrow("Unknown or irrelevant");
  expect(() =>
    selectReports(
      { reports: new Map(), workflows: new Map() },
      "task",
      Source.id,
      { only: ["missing"] }
    )
  ).toThrow("task describe source");
});

test("normalization preserves no-op receipts, rejects invalid combinations and bounds decisions", () => {
  expect(
    normalizeSelection({ only: [], onlyTags: {}, skip: [], skipAll: false })
  ).toEqual({});
  expect(normalizeSelection({ only: ["z", "a", "a"] })).toEqual({
    only: ["a", "z"],
  });
  expect(() => normalizeSelection({ only: ["a"], skipAll: true })).toThrow();
  expect(() => normalizeSelection({ only: undefined })).toThrow();
  expect(() => normalizeSelection({ extra: true })).toThrow();
  expect(() => normalizeSelection({ only: ["bad:id"] })).toThrow();
  expect(() =>
    normalizeSelection({
      only: Array.from({ length: 129 }, (_, index) => `id-${index}`),
    })
  ).toThrow();
  const decode = Schema.decodeUnknownSync(SelectionDecision);
  expect(() =>
    decode({ excluded: ["x"], requested: {}, required: [], selected: ["x"] })
  ).toThrow();
  expect(() =>
    decode({ excluded: [], requested: {}, required: ["x"], selected: [] })
  ).toThrow();
});

test("candidates include inactive templates, shared children and extension patches without executing handlers", async () => {
  let executed = 0;
  const task = (id: string) =>
    Task.make(
      {
        error: Schema.Never,
        id,
        input: Schema.String,
        replay: "idempotent",
        success: Schema.String,
        version: 1,
      },
      (input) =>
        Effect.sync(() => {
          executed += 1;
          return input;
        })
    );
  const Direct = task("direct");
  const Yes = task("yes");
  const No = task("no");
  const Item = task("item");
  const Leaf = task("leaf");
  const Unrelated = task("unrelated");
  const Patched = task("selection/test/check");
  const spec = {
    error: Schema.Never,
    input: Schema.String,
    success: Schema.String,
    version: 1,
  };
  const Child = Workflow.make(
    { ...spec, id: "child" },
    Effect.gen(function* () {
      const g = yield* Workflow.Builder;
      return yield* g.task("leaf", Leaf, "v");
    })
  );
  const RootInput = Schema.Struct({
    choice: Schema.Boolean,
    items: Schema.Array(Schema.String),
  });
  const Root = Workflow.make(
    { ...spec, id: "root", input: RootInput },
    Effect.gen(function* () {
      const g = yield* Workflow.Builder;
      yield* g.task("direct", Direct, "v");
      const input = yield* g.input(RootInput);
      yield* g.branch("branch", Ref.field(input, "choice"), {
        onFalse: Effect.gen(function* () {
          const b = yield* Workflow.Builder;
          return yield* b.task("no", No, "v");
        }),
        onTrue: Effect.gen(function* () {
          const b = yield* Workflow.Builder;
          return yield* b.task("yes", Yes, "v");
        }),
        success: Schema.String,
      });
      // oxlint-disable-next-line no-array-for-each -- Workflow graph combinator, not Array.forEach.
      yield* g.forEach(
        "items",
        Ref.field(input, "items"),
        {
          concurrency: 2,
          item: Schema.String,
          key: (value) => value,
          maxItems: 2,
          success: Schema.String,
        },
        (item) =>
          Effect.gen(function* () {
            const b = yield* Workflow.Builder;
            yield* b.workflow("child", Child, item);
            return yield* b.task("item", Item, item);
          })
      );
      return yield* g.workflow("child", Child, "v");
    })
  );
  const Patch = WorkflowPatch.make(
    { id: "selection/test/before", target: Direct },
    (input) =>
      Effect.gen(function* () {
        const g = yield* Workflow.Builder;
        yield* g.task("check", Patched, input);
      })
  );
  const extension = Extension.make({
    id: "selection/test",
    patches: [Patch],
    tasks: { Check: Patched },
    version: "1.0.0",
  });
  const registered = await Effect.runPromise(
    Application.Registry.pipe(
      Effect.provide(
        Application.make({
          extensions: [
            Extension.use(extension, {
              patches: [
                {
                  at: ["direct"],
                  id: "before",
                  use: Patch.id,
                  workflow: { id: Root.id, version: 1 },
                },
              ],
            }),
          ],
          reports: [
            ...[Direct, Yes, No, Item, Leaf, Unrelated, Patched].map((target) =>
              Report.make({
                id: `report/${target.id}`,
                scope: "invocation",
                target,
                task: Reporter,
              })
            ),
            Report.make({ id: "root-report", target: Root, task: Reporter }),
            Report.make({
              id: "child-root-report",
              target: Child,
              task: Reporter,
            }),
            Report.make({
              id: "direct-root",
              scope: "run",
              target: Direct,
              task: Reporter,
            }),
          ],
          tasks: [Direct, Yes, No, Item, Leaf, Unrelated, Reporter],
          workflows: [Root],
        }).layer
      )
    )
  );
  expect(
    selectReports(registered, "workflow", "root").decision.selected
  ).toEqual([
    "report/direct",
    "report/item",
    "report/leaf",
    "report/no",
    "report/selection/test/check",
    "report/yes",
    "root-report",
  ]);
  expect(selectReports(registered, "task", "direct").decision.selected).toEqual(
    ["direct-root", "report/direct"]
  );
  expect(() =>
    selectReports(registered, "workflow", "root", {
      only: ["report/unrelated"],
    })
  ).toThrow("irrelevant");
  expect(executed).toBe(0);
});

export function selectionTypeProof() {
  Report.make({
    id: "bad",
    scope: "run",
    // @ts-expect-error A bare definition is not attachment classification.
    tags: [Category],
    target: Source,
    task: Reporter,
  });
  // @ts-expect-error A classification binding retains its literal value type.
  Category("unknown");
  Report.make({
    id: "bad",
    // @ts-expect-error Required is a boolean.
    required: "yes",
    scope: "run",
    target: Source,
    task: Reporter,
  });
  // @ts-expect-error Scheduled selection does not accept bare declarations.
  const invalid: Report.Selection = { onlyTags: [Category] };
  return invalid;
}

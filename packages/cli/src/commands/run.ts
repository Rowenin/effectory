/**
 * `effectory run <workflow>`, its `resume | inspect | list | cancel`
 * subcommands, and `effectory action run <Action>`.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  Action,
  Assert,
  Engine,
  Plan,
  Report,
  State,
  Target,
} from "@effectory/core";
import type { Workflow } from "@effectory/core";
import type { FailOn } from "@effectory/core/assert";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import {
  printJson,
  renderApprovals,
  renderNodes,
  renderRecords,
  renderRunHeader,
  renderRuns,
  setExitCode,
} from "../output.ts";
import {
  CliFailure,
  Runtime,
  findRun,
  withRuntime,
  workflowOf,
} from "../runtime.ts";

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// --- flags -------------------------------------------------------------------

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON"),
  Flag.withDefault(false)
);
const inputs = Flag.String("input").pipe(
  Flag.withDescription(
    "Input assignment key=value (dotted keys nest; JSON values are parsed); repeatable"
  ),
  Flag.atLeast(0)
);
const inputJson = Flag.String("input-json").pipe(
  Flag.withDescription("Input as a JSON object"),
  Flag.optional
);
const mode = Flag.Literals("mode", ["live", "fake"]).pipe(
  Flag.withDescription("Use live or fake providers and Actions"),
  Flag.withDefault("live")
);
const concurrency = Flag.Int("concurrency").pipe(
  Flag.withDescription("Most nodes executing at once (default 8)"),
  Flag.optional
);
const failOn = Flag.Literals("fail-on", ["low", "medium", "high", "none"]).pipe(
  Flag.withDescription(
    "Lowest failed-assertion severity that fails the run (exit 1)"
  ),
  Flag.withDefault("low")
);
const junit = Flag.String("junit").pipe(
  Flag.withDescription(
    "Write JUnit XML; bare --junit writes junit.xml, --junit=<file> (or --junit <file>.xml) names the file"
  ),
  Flag.withOptionalValue("junit.xml"),
  Flag.optional
);

interface FinishOptions {
  readonly failOn: FailOn;
  readonly junit: Option.Option<string>;
  readonly json: boolean;
}

// --- shared execution ----------------------------------------------------------

/** Merge the Target preset, `--input-json`, then `--input` assignments. */
export const buildInput = (options: {
  readonly preset: Readonly<Record<string, unknown>> | undefined;
  readonly inputJson: Option.Option<string>;
  readonly inputs: readonly string[];
}) =>
  Effect.try({
    catch: (error) =>
      new CliFailure({ message: `Invalid input: ${messageOf(error)}` }),
    try: () => {
      let input: unknown = options.preset ?? {};
      if (Option.isSome(options.inputJson)) {
        input = Target.merge(input, JSON.parse(options.inputJson.value));
      }
      if (options.inputs.length > 0) {
        input = Target.merge(input, Target.parseAssignments(options.inputs));
      }
      return input;
    },
  });

/** 0 succeeded, 1 failed or cancelled or failing assertions, 2 suspended. */
export const exitCodeOf = (
  run: State.RunRow,
  records: readonly State.RecordRow[],
  threshold: FailOn
): 0 | 1 | 2 => {
  if (run.status === "suspended") {
    return 2;
  }
  return Assert.exitCode({ records, run }, threshold);
};

/** Print a finished (or suspended) run, write JUnit, and set the exit code. */
const finish = Effect.fn("finish")(function* finish(
  summary: Engine.RunSummary,
  options: FinishOptions
) {
  const state = yield* State.State;
  const { run, nodes } = summary;
  const records = yield* state.records({
    collection: run.collection,
    runId: run.id,
  });
  const approvals = yield* state.listApprovals({
    runId: run.id,
    status: "pending",
  });
  const failures = Assert.failures(records, options.failOn);
  const assertions = Report.assertions(records);
  const code = exitCodeOf(run, records, options.failOn);
  let junitFile: string | undefined;
  if (Option.isSome(options.junit)) {
    junitFile = path.resolve(options.junit.value);
    const target = junitFile;
    yield* Effect.try({
      catch: (error) =>
        new CliFailure({
          message: `Could not write ${target}: ${messageOf(error)}`,
        }),
      try: () => writeFileSync(target, Assert.junit({ nodes, records, run })),
    });
  }
  if (options.json) {
    yield* printJson({
      approvals,
      assertions,
      exitCode: code,
      failures: failures.map((record) => ({
        fqn: record.fqn,
        ...record.value,
      })),
      nodes,
      run,
      ...(junitFile === undefined ? {} : { junit: junitFile }),
    });
    return yield* setExitCode(code);
  }
  const lines = [renderRunHeader(run), renderNodes(nodes)];
  if (assertions.length > 0) {
    const passed = assertions.filter((assertion) => assertion.passed).length;
    lines.push(
      "",
      `Assertions: ${passed}/${assertions.length} passed (fail-on ${options.failOn})`,
      ...assertions
        .filter((assertion) => !assertion.passed)
        .map(
          (assertion) =>
            `  FAIL [${assertion.severity}] ${assertion.fqn}: ${assertion.message}`
        )
    );
  }
  if (approvals.length > 0) {
    lines.push(
      "",
      "Awaiting approval:",
      ...approvals.map((approval) => `  ${approval.id}  ${approval.title}`),
      "",
      "Decide with `effectory approval approve <id>` (or `reject`), then `effectory run resume " +
        `${run.id}\`.`
    );
  }
  if (run.error !== undefined) {
    lines.push("", `Error: ${run.error}`);
  }
  if (run.result !== undefined) {
    lines.push("", `Result: ${JSON.stringify(run.result, null, 2)}`);
  }
  if (junitFile !== undefined) {
    lines.push("", `JUnit written to ${junitFile}`);
  }
  yield* Console.log(lines.join("\n"));
  return yield* setExitCode(code);
});

interface ExecuteOptions extends FinishOptions {
  readonly workflow: Workflow.Any;
  readonly input: unknown;
  readonly mode: "live" | "fake";
  readonly concurrency: Option.Option<number>;
  readonly target?: string;
  readonly plan: boolean;
  readonly mermaid: boolean;
}

const execute = Effect.fn("execute")(function* execute(
  options: ExecuteOptions
) {
  const { collection, revision } = yield* Runtime;
  const engine = yield* Engine.Engine;
  const runOptions: Engine.RunOptions = {
    collection: collection.name,
    mode: options.mode,
    revision,
    ...(Option.isSome(options.concurrency)
      ? { concurrency: options.concurrency.value }
      : {}),
    ...(options.target === undefined ? {} : { target: options.target }),
  };
  if (options.plan || options.mermaid) {
    const planned = yield* engine.plan(
      options.workflow,
      options.input,
      runOptions
    );
    if (options.json) {
      return yield* printJson({
        entries: planned.entries,
        scope: planned.scope,
      });
    }
    return yield* Console.log(
      options.mermaid
        ? Plan.renderMermaid(planned.built.graph)
        : `Plan for ${options.workflow.name} (scope ${planned.scope}):\n${Plan.renderText(planned.entries)}`
    );
  }
  const summary = yield* engine.run(
    options.workflow,
    options.input,
    runOptions
  );
  return yield* finish(summary, options);
});

// --- run <workflow> -----------------------------------------------------------

const runWorkflow = Effect.fn("runWorkflow")(function* runWorkflow(flags: {
  readonly workflow: string;
  readonly target: Option.Option<string>;
  readonly input: readonly string[];
  readonly inputJson: Option.Option<string>;
  readonly mode: "live" | "fake";
  readonly concurrency: Option.Option<number>;
  readonly plan: boolean;
  readonly mermaid: boolean;
  readonly failOn: FailOn;
  readonly junit: Option.Option<string>;
  readonly json: boolean;
}) {
  const { collection } = yield* Runtime;
  const workflow = collection.workflows.find(
    (candidate) => candidate.name === flags.workflow
  );
  if (workflow === undefined) {
    const names = collection.workflows.map((candidate) => candidate.name);
    return yield* new CliFailure({
      message: `No workflow ${flags.workflow}; workflows: ${names.join(", ") || "(none)"}`,
    });
  }
  let target: Target.Any | undefined;
  if (Option.isSome(flags.target)) {
    const name = flags.target.value;
    target = collection.targets.find(
      (candidate) =>
        candidate.name === name && candidate.workflow.name === workflow.name
    );
    if (target === undefined) {
      return yield* new CliFailure({
        message: `No target ${name} for workflow ${workflow.name}`,
      });
    }
  }
  const input = yield* buildInput({
    inputJson: flags.inputJson,
    inputs: flags.input,
    preset: target?.input,
  });
  return yield* execute({
    concurrency: flags.concurrency,
    failOn: flags.failOn,
    input,
    json: flags.json,
    junit: flags.junit,
    mermaid: flags.mermaid,
    mode: flags.mode,
    plan: flags.plan,
    workflow,
    ...(target === undefined ? {} : { target: target.name }),
  });
});

const resume = Command.make(
  "resume",
  {
    concurrency,
    failOn,
    id: Argument.String("run-id"),
    json,
    junit,
  },
  (flags) =>
    withRuntime(
      Effect.gen(function* resumeRun() {
        const { revision } = yield* Runtime;
        const engine = yield* Engine.Engine;
        const run = yield* findRun(flags.id);
        const workflow = yield* workflowOf(run.workflow);
        const summary = yield* engine.resume(workflow, run.id, {
          revision,
          ...(Option.isSome(flags.concurrency)
            ? { concurrency: flags.concurrency.value }
            : {}),
        });
        return yield* finish(summary, flags);
      })
    )
).pipe(
  Command.withDescription(
    "Continue a suspended, failed, or interrupted run (refused if the collection source changed)"
  )
);

const inspect = Command.make(
  "inspect",
  {
    id: Argument.String("run-id"),
    json,
    report: Flag.String("report").pipe(
      Flag.withDescription("Print one rendered report of the run"),
      Flag.optional
    ),
  },
  (flags) =>
    withRuntime(
      Effect.gen(function* inspectRun() {
        const state = yield* State.State;
        const run = yield* findRun(flags.id);
        if (Option.isSome(flags.report)) {
          const rendered = yield* Report.latest(run.id, flags.report.value);
          if (flags.json) {
            return yield* printJson(rendered);
          }
          return yield* "content" in rendered
            ? Console.log(rendered.content)
            : new CliFailure({
                message: `Report ${flags.report.value} failed: ${rendered.error}`,
              });
        }
        const nodes = yield* state.getNodes(run.id);
        const records = yield* state.records({
          collection: run.collection,
          runId: run.id,
        });
        const approvals = yield* state.listApprovals({ runId: run.id });
        const reports = records.filter((record) => record.kind === "Report");
        if (flags.json) {
          return yield* printJson({ approvals, nodes, records, run });
        }
        const lines = [
          renderRunHeader(run),
          `Revision ${run.revision.slice(0, 12)}, created ${new Date(run.createdAt).toISOString()}, updated ${new Date(run.updatedAt).toISOString()}`,
          `Input: ${JSON.stringify(run.input)}`,
          "",
          "Nodes:",
          renderNodes(nodes),
          "",
          "Records:",
          renderRecords(
            records.filter((record) => record.kind !== "Report").toReversed()
          ),
          "",
          "Approvals:",
          renderApprovals(approvals),
        ];
        if (reports.length > 0) {
          lines.push(
            "",
            "Reports (print one with --report <name>):",
            ...reports.map(
              (record) => `  ${Report.nameOf(run.workflow, record.fqn)}`
            )
          );
        }
        if (run.error !== undefined) {
          lines.push("", `Error: ${run.error}`);
        }
        if (run.result !== undefined) {
          lines.push("", `Result: ${JSON.stringify(run.result, null, 2)}`);
        }
        return yield* Console.log(lines.join("\n"));
      })
    )
).pipe(
  Command.withDescription("Show a run's nodes, records, approvals, and reports")
);

const list = Command.make(
  "list",
  {
    json,
    limit: Flag.Int("limit").pipe(Flag.withDefault(20)),
    status: Flag.Literals("status", [
      "running",
      "succeeded",
      "failed",
      "suspended",
      "cancelled",
    ]).pipe(Flag.optional),
    workflow: Flag.String("workflow").pipe(Flag.optional),
  },
  (flags) =>
    withRuntime(
      Effect.gen(function* listRuns() {
        const { collection } = yield* Runtime;
        const state = yield* State.State;
        const runs = yield* state.listRuns({
          collection: collection.name,
          limit: flags.limit,
          ...(Option.isSome(flags.status)
            ? { status: flags.status.value }
            : {}),
          ...(Option.isSome(flags.workflow)
            ? { workflow: flags.workflow.value }
            : {}),
        });
        return yield* flags.json
          ? printJson(runs)
          : Console.log(renderRuns(runs));
      })
    )
).pipe(Command.withDescription("List runs, newest first"));

const cancel = Command.make(
  "cancel",
  { id: Argument.String("run-id"), json },
  (flags) =>
    withRuntime(
      Effect.gen(function* cancelRun() {
        const { revision } = yield* Runtime;
        const engine = yield* Engine.Engine;
        const run = yield* findRun(flags.id);
        const workflow = yield* workflowOf(run.workflow);
        const summary = yield* engine.cancel(workflow, run.id, { revision });
        if (flags.json) {
          return yield* printJson(summary);
        }
        const error =
          summary.run.error === undefined
            ? ""
            : `\nError: ${summary.run.error}`;
        return yield* Console.log(`${renderRunHeader(summary.run)}${error}`);
      })
    )
).pipe(
  Command.withDescription(
    "Finish an unfinished run without executing more nodes; deletes its run-lifetime resources"
  )
);

export const run = Command.make(
  "run",
  {
    concurrency,
    failOn,
    input: inputs,
    inputJson,
    json,
    junit,
    mermaid: Flag.Boolean("mermaid").pipe(
      Flag.withDescription(
        "With --plan: print the plan as a Mermaid flowchart"
      ),
      Flag.withDefault(false)
    ),
    mode,
    plan: Flag.Boolean("plan").pipe(
      Flag.withDescription("Print the plan and exit without executing"),
      Flag.withDefault(false)
    ),
    target: Flag.String("target").pipe(
      Flag.withDescription("Start from a Target's input preset"),
      Flag.optional
    ),
    workflow: Argument.String("workflow"),
  },
  (flags) => withRuntime(runWorkflow(flags))
).pipe(
  Command.withDescription(
    "Run a workflow. Exit 0 succeeded, 1 failed (or failing assertions), 2 suspended awaiting approval."
  ),
  Command.withSubcommands([resume, inspect, list, cancel])
);

const actionRun = Command.make(
  "run",
  {
    action: Argument.String("action"),
    concurrency,
    failOn,
    input: inputs,
    inputJson,
    json,
    junit,
    mode,
    plan: Flag.Boolean("plan").pipe(
      Flag.withDescription("Print the plan and exit without executing"),
      Flag.withDefault(false)
    ),
  },
  (flags) =>
    withRuntime(
      Effect.gen(function* runAction() {
        const { collection } = yield* Runtime;
        const action = collection.actions.find(
          (candidate) => candidate.type === flags.action
        );
        if (action === undefined) {
          const types = collection.actions.map((candidate) => candidate.type);
          return yield* new CliFailure({
            message: `No Action ${flags.action}; Actions: ${types.join(", ") || "(none)"}`,
          });
        }
        const input = yield* buildInput({
          inputJson: flags.inputJson,
          inputs: flags.input,
          preset: undefined,
        });
        return yield* execute({
          concurrency: flags.concurrency,
          failOn: flags.failOn,
          input,
          json: flags.json,
          junit: flags.junit,
          mermaid: false,
          mode: flags.mode,
          plan: flags.plan,
          workflow: Action.toWorkflow(action) as Workflow.Any,
        });
      })
    )
).pipe(
  Command.withDescription(
    "Run one collection Action as a one-node workflow (scope adhoc)"
  )
);

export const action = Command.make("action").pipe(
  Command.withDescription("Run collection Actions directly"),
  Command.withSubcommands([actionRun])
);

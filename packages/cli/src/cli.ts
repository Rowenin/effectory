/** The `flow` command tree. */
import { readFileSync } from "node:fs";
import path from "node:path";

import { Flow } from "@effectory/flow";
import { Console, Data, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { entryFile, loadApp, sqliteStore, storeFile } from "./load.ts";

export const version = "0.0.0";

/** The command was used in a way that can't work. */
export class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
}> {}

const root = Command.make("flow").pipe(
  Command.withDescription("Run, resume and inspect the Tasks in flow.run.ts."),
  Command.withSharedFlags({
    db: Flag.String("db").pipe(
      Flag.withDescription(`Run store (default: ./${storeFile})`),
      Flag.optional
    ),
    file: Flag.String("file").pipe(
      Flag.withDescription(`Entry file (default: ./${entryFile})`),
      Flag.optional
    ),
  })
);

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON"),
  Flag.withDefault(false)
);

/** The loaded app and the store for this invocation. */
const context = Effect.gen(function* loadContext() {
  const flags = yield* root;
  const cwd = process.cwd();
  const file = path.resolve(
    cwd,
    Option.getOrElse(flags.file, () => entryFile)
  );
  const db = path.resolve(
    cwd,
    Option.getOrElse(flags.db, () => storeFile)
  );
  return { app: yield* loadApp(file), store: sqliteStore(db) };
});

/** JSON given inline, or read from a file when it starts with `@`. */
const readJson = (text: string) =>
  Effect.suspend(() =>
    Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
      text.startsWith("@") ? readFileSync(text.slice(1), "utf-8") : text
    )
  );

const print = (value: unknown) => JSON.stringify(value);

/** Report how a run ended, using the stored (JSON) output and error. */
const report = (
  app: Flow.App,
  outcome: Flow.Outcome<unknown, unknown>,
  asJson: boolean
) =>
  Effect.gen(function* reportOutcome() {
    const { run } = yield* app.status(outcome.runId);
    if (asJson) {
      yield* Console.log(
        print({
          _tag: outcome._tag,
          error: run.error,
          output: run.output,
          pending: run.pending,
          runId: run.id,
          timers: run.timers,
        })
      );
    } else if (outcome._tag === "Succeeded") {
      yield* Console.log(`Run ${run.id} succeeded:\n${print(run.output)}`);
    } else if (outcome._tag === "Suspended") {
      yield* Console.log(`Run ${run.id} is waiting for:`);
      for (const input of run.pending) {
        yield* Console.log(`\n  ${input.key}`);
        if (input.description) {
          yield* Console.log(`    ${input.description}`);
        }
        yield* Console.log(`    request: ${print(input.request)}`);
        if (input.rejected) {
          yield* Console.log(`    last response rejected: ${input.rejected}`);
        }
      }
      for (const timer of run.timers) {
        yield* Console.log(
          `\n  ${timer.key}\n    wakes at ${new Date(timer.wakeAt).toISOString()}`
        );
      }
      if (run.pending.length === 1) {
        yield* Console.log(
          `\nRespond with: flow resume ${run.id} --respond '<json>' (or @file.json)`
        );
      } else if (run.pending.length > 1) {
        yield* Console.log(
          `\nRespond with: flow resume ${run.id} --responses '{"<key>": <json>}' (or @file.json)`
        );
      }
      if (run.timers.length > 0) {
        const latest = Math.max(...run.timers.map((timer) => timer.wakeAt));
        yield* Console.log(
          `\nResume after ${new Date(latest).toISOString()} with: flow resume ${run.id}`
        );
      }
    } else {
      const [reason = "unknown error"] = (run.error ?? "").split("\n");
      yield* Console.error(
        `Run ${run.id} failed: ${reason}\n(details: flow status ${run.id} --json)`
      );
    }
    if (outcome._tag === "Failed") {
      process.exitCode = 1;
    }
  });

const tasks = Command.make(
  "tasks",
  {
    json,
    query: Argument.String("query").pipe(
      Argument.withDescription(
        "Text to find in names, descriptions and labels"
      ),
      Argument.optional
    ),
  },
  Effect.fn(function* listTasks({ json: asJson, query }) {
    const { app } = yield* context;
    const found = app.search(Option.getOrElse(query, () => ""));
    if (asJson) {
      yield* Console.log(
        print(
          found.map((task) => ({
            description: task.description,
            kind: task.kind,
            labels: task.labels,
            name: task.name,
          }))
        )
      );
      return;
    }
    for (const task of found) {
      const labels =
        task.labels.length > 0 ? ` [${task.labels.join(", ")}]` : "";
      const kind = task.kind === "input" ? " (input)" : "";
      yield* Console.log(
        `${task.name}${kind}${labels}${task.description ? `\n  ${task.description}` : ""}`
      );
    }
  })
).pipe(Command.withDescription("List or search Tasks"));

const inputFlag = Flag.String("input").pipe(
  Flag.withDescription("The Task's input as JSON, or @file.json"),
  Flag.optional
);
const taskArgument = Argument.String("task").pipe(
  Argument.withDescription("Task name")
);
const inputOf = (input: Option.Option<string>) =>
  Option.match(input, { onNone: () => Effect.succeed(null), onSome: readJson });

const plan = Command.make(
  "plan",
  { input: inputFlag, json, task: taskArgument },
  Effect.fn(function* planTask({ input, json: asJson, task }) {
    const { app } = yield* context;
    const planned = yield* app.plan(task, yield* inputOf(input));
    yield* Console.log(
      asJson
        ? print(planned.order.map((key) => planned.nodes.get(key)?.node))
        : Flow.toMermaid(planned)
    );
  })
).pipe(Command.withDescription("Plan a Task without running it"));

const run = Command.make(
  "run",
  { input: inputFlag, json, task: taskArgument },
  Effect.fn(function* runTask({ input, json: asJson, task }) {
    const { app, store } = yield* context;
    yield* Effect.gen(function* startRun() {
      const outcome = yield* app.start(task, yield* inputOf(input));
      yield* report(app, outcome, asJson);
    }).pipe(Effect.provide(store));
  })
).pipe(Command.withDescription("Start a durable run of a Task"));

const resume = Command.make(
  "resume",
  {
    json,
    respond: Flag.String("respond").pipe(
      Flag.withDescription(
        "The response to the run's only pending Input, as JSON or @file.json"
      ),
      Flag.optional
    ),
    responses: Flag.String("responses").pipe(
      Flag.withDescription(
        "Responses by Input key, as a JSON object or @file.json"
      ),
      Flag.optional
    ),
    runId: Argument.String("run").pipe(Argument.withDescription("Run id")),
  },
  Effect.fn(function* resumeRun({ json: asJson, respond, responses, runId }) {
    const { app, store } = yield* context;
    yield* Effect.gen(function* resumeWithResponses() {
      const answers: Record<string, unknown> = {};
      if (Option.isSome(responses)) {
        Object.assign(
          answers,
          yield* Schema.decodeUnknownEffect(
            Schema.Record(Schema.String, Schema.Unknown)
          )(yield* readJson(responses.value))
        );
      }
      if (Option.isSome(respond)) {
        const { pending } = (yield* app.status(runId)).run;
        const [only, ...rest] = pending;
        if (!only || rest.length > 0) {
          return yield* new UsageError({
            message: `--respond needs exactly one pending Input; run ${runId} has ${pending.length}. Use --responses.`,
          });
        }
        answers[only.key] = yield* readJson(respond.value);
      }
      const outcome = yield* app.resume(runId, answers);
      yield* report(app, outcome, asJson);
    }).pipe(Effect.provide(store));
  })
).pipe(
  Command.withDescription("Respond to a run's pending Inputs and continue it")
);

const status = Command.make(
  "status",
  {
    json,
    mermaid: Flag.Boolean("mermaid").pipe(
      Flag.withDescription("Print the graph the run followed as Mermaid"),
      Flag.withDefault(false)
    ),
    runId: Argument.String("run").pipe(Argument.withDescription("Run id")),
  },
  Effect.fn(function* runStatus({ json: asJson, mermaid, runId }) {
    const { app, store } = yield* context;
    const state = yield* app.status(runId).pipe(Effect.provide(store));
    if (asJson) {
      yield* Console.log(print(state));
      return;
    }
    if (mermaid) {
      yield* Console.log(Flow.toMermaidRun(state));
      return;
    }
    yield* Console.log(
      `Run ${state.run.id} of ${state.run.task}: ${state.run.status}`
    );
    for (const node of state.nodes) {
      yield* Console.log(
        `  ${node.status.padEnd(9)} ${String(node.attempts).padStart(2)}  ${node.key}`
      );
    }
  })
).pipe(Command.withDescription("Show a run and its nodes"));

const runs = Command.make(
  "runs",
  { json },
  Effect.fn(function* listRuns({ json: asJson }) {
    const { app, store } = yield* context;
    const records = yield* app.runs.pipe(Effect.provide(store));
    if (asJson) {
      yield* Console.log(
        print(
          records.map(({ id, status: state, task }) => ({
            id,
            status: state,
            task,
          }))
        )
      );
      return;
    }
    for (const record of records) {
      yield* Console.log(
        `${record.id}  ${record.status.padEnd(9)}  ${record.task}`
      );
    }
  })
).pipe(Command.withDescription("List runs"));

export const cli = root.pipe(
  Command.withSubcommands([tasks, plan, run, resume, status, runs])
);

/** Run the CLI over `args` (without the executable and script). */
export const main = (args: readonly string[]) =>
  Command.runWith(cli, { version })(args);

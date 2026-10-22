# Authoring automations

An automation is built from three kinds of thing:

- **Services** are capabilities, such as running a command (`Process`) or calling a coding agent (`Agent`). They are configured once in `effectory.run.ts` and provided as Effect layers. Calling one does real work but records nothing.
- **Tasks** are named, durable steps made with `Task.make`. A Task's result is recorded; replay returns the record instead of running the body again. Anything that touches the outside world, costs money, or waits on a person happens inside a Task.
- **Workflows** are the entry points. Compose them declaratively from steps with `Workflow.make`; each step runs a Task, and steps pass typed references to each other's outputs. `Automation.define` remains as a lower-level, imperative alternative.

Import `Task` and `Automation` from `@effectory/sdk`; standard services come from `@effectory/activities`. Host code uses `@effectory/runtime`, while `@effectory/cli` supplies the terminal interface. The SDK has no dependency on either package or SQLite. Native Effect Workflow and Activity provide persistence, replay, and suspension. Implementations remain ordinary Effect programs.

```text
.effectory/
  workspace.json
  state/                 # Generated socket and local action outputs
  automations/
    greet/
      index.ts           # the workflow
      tasks.ts           # its Tasks
    shared/
      services/
```

The root `effectory.run.ts` explicitly registers runnable definitions in `Effectory.make({ workflows, services })`. Each definition needs a unique lowercase kebab-case name; filenames and directories do not determine registration. The layout above is a convention. Unlisted definitions are not runnable, and unimported files are not evaluated. These are trusted executable modules, not sandboxed plugins.

## Compose a workflow

A workflow is a plan: a value built from step primitives, much like a Swamp workflow file, with typed references in place of `${{ }}` expressions. Each step's input binds literals and references to the workflow input (`$.input`) or earlier steps (`$.steps`):

```ts
// .effectory/automations/review-branch/index.ts
import { Expr, Workflow } from "@effectory/sdk";

export default Workflow.make("review-branch", {
  description: "Review a branch, gate on findings, and draft a release note.",
  input: Schema.Struct({
    requestId: Schema.String,
    repo: Schema.String,
    base: Schema.String,
  }),
  key: ($) => $.input.requestId,
}).pipe(
  Workflow.step("diff", diff, ($) => ({
    repo: $.input.repo,
    base: $.input.base,
  })),
  Workflow.each("review", ["correctness", "security"], reviewAs, ($, lens) => ({
    diff: $.steps.diff,
    lens,
  })),
  Workflow.compute("verdict", decide, ($) => ({
    reviews: $.steps.review,
    failOn: "high",
  })),
  Workflow.publish("review", Review, ($) => $.steps.verdict),
  Workflow.approve("accept-findings", {
    title: "Review found blocking findings; continue?",
    review: ($) => $.steps.verdict.findings,
    when: ($) => Expr.eq($.steps.verdict.verdict, "fail"),
  }),
  Workflow.step("release-note", releaseNote, ($) => ({ diff: $.steps.diff })),
  Workflow.returns(Output, ($) => ({
    note: $.steps["release-note"],
    verdict: $.steps.verdict.verdict,
  }))
);
```

| Primitive | Does | Swamp equivalent |
| --- | --- | --- |
| `step(name, task, bind)` | Runs a Task once; its output becomes `$.steps[name]` | step with a `behavior` task |
| `each(name, items, task, bind)` | Runs a Task once per item, concurrently; outputs are an array | `forEach` |
| `compute(name, f, bind)` | Derives a value with a pure function; recomputed on replay, not recorded | an expression |
| `approve(key, { title, review, when? })` | Waits for a person; rejection fails the run | `manual_approval`, with `guard` |
| `publish(name, schema, value)` | Publishes a named artifact | data output |
| `returns(schema, value)` | Finishes the plan with the run's result |  |

`Expr.eq`, `Expr.not`, `Expr.and`, and `Expr.or` build conditions from references. Binding functions run once, when the plan is built, against typed proxies; they describe data flow and never run during execution.

The plan is checked at compile time. Referencing a step that does not exist yet, binding a value of the wrong type, using a literal outside a Task's input schema, or returning a value that does not match the output schema is a type error. The services every step's Task needs flow to `Effectory.make`, which fails with `Missing 'Agent'` until the root provides them.

Each step's name is its durable key; `each` records item runs as `name/item`. There are no user-supplied keys. Step names, approval keys, and artifact names must each be unique within a plan. `Workflow.tasks(definition.plan)` lists the Tasks a workflow runs by step name.

Steps run in order, and `each` runs its items concurrently. A plan's steps are leaf Tasks; to group work, prefer more steps over a composite Task.

`Workflow.call(name, definition, bind)` runs another finished workflow as one step of the same run. Its input is checked against that workflow's schema, its steps, approvals, and artifacts are recorded under `name/` (so `implement/accept-failing-checks`), and its result becomes `steps[name]`. The services its Tasks need flow to the root like any other step. `.effectory/automations/plan-implement` calls the standalone `implement` workflow after its plan is approved.

## Define a task

```ts
// .effectory/automations/greet/tasks.ts
import { Task } from "@effectory/sdk";
import { Effect, Schema } from "effect";

export const greet = Task.make({
  name: "greet",
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  error: Schema.Never,
  run: ({ name }) => Effect.succeed(`Hello, ${name}`),
});
```

The returned function accepts the decoded input type and returns an Effect that runs the Task durably. Effectory validates input before running the body and validates its success before recording it. Use `Schema.Void` and `Schema.Never` explicitly when there is no result or domain error. A body may also fail with `AutomationError`. The Task exposes its `taskName`, `input`, `success`, and `error` schemas; `error` already includes `AutomationError`.

Task names identify reusable operations. A call without a key has one durable identity per parent. Supply a stable key for each distinct call, particularly in loops or concurrent traversals:

```ts
const first = yield * greet({ name: "Ada" }, { key: "ada" });
const second = yield * greet({ name: "Grace" }, { key: "grace" });
```

Reusing a name and key reuses its recorded outcome, even if arguments differ. Keys must come from stable logical identities, not random values or changing array positions. Do not rename Tasks or change keys while expecting existing executions to replay the same operations. The current host refuses changed source revisions with unfinished runs.

Recording completion does not make external side effects exactly once. A process can stop after the side effect but before its result is committed. Use external idempotency keys or reconcile the operation's existing result.

### Tasks inside Tasks

A Task body may call other Tasks. Children are recorded under their parent's key, so the same child key in two parents does not collide. If a parent's body re-runs, after a crash or when it resumes from an approval inside it, its finished children replay from their records and only unfinished work runs again:

```ts
const reviewAs = Task.make({
  name: "review-as",
  /* ... */ run: ({ lens, diff }) => Agent.generate(/* ... */),
});

export const codeReview = Task.make({
  name: "code-review",
  input: Schema.Struct({
    diff: Schema.String,
    lenses: Schema.Array(Schema.String),
  }),
  success: Review,
  error: Agent.Failure,
  run: ({ diff, lenses }) =>
    Effect.forEach(lenses, (lens) => reviewAs({ diff, lens }, { key: lens }), {
      concurrency: "unbounded",
    }).pipe(Effect.map(decide)), // decide is pure
});
```

Keep the two kinds of body separate. A _leaf_ Task does side effects directly through services and calls no Tasks. A _composite_ Task calls child Tasks and pure functions only, and follows workflow rules: it must be deterministic and take child keys from its input. Put approvals in workflows or composite Tasks, never in a leaf: a leaf that suspends repeats its side effects when it resumes.

`Activity.define` is deprecated. It defines a leaf operation that cannot call services requiring `InTask` or nest Tasks.

### Services only run inside Tasks

Service calls with side effects, such as `Process.exec`, `Agent.run`, and `Agent.generate`, require the `InTask` marker. Only `Task.make` provides it. Calling one directly in a workflow body would run again on every replay, so it fails to typecheck instead:

```text
This Effect requires a service that is missing from the expected Effect context: `InTask`.
```

Each service is also a layer requirement. A workflow whose Tasks use `Agent` requires the `Agent` layer, and `Effectory.make` fails to typecheck until `effectory.run.ts` provides it: `Missing 'Agent' in the expected Layer context`.

## Run a process

`Process` runs installed executables. Provide `Process.layer`, or `Process.make(defaults)` to set `cwd`, `env`, `extendEnv`, `timeoutMs`, or `maxOutputBytes` for every command, in `effectory.run.ts`. Call `Process.exec` from a Task:

```ts
import { Process } from "@effectory/activities";
import { Task } from "@effectory/sdk";

export const diffStat = Task.make({
  name: "git.diff-stat",
  input: Schema.Struct({ repo: Schema.String }),
  success: Schema.String,
  error: Process.Failure,
  run: ({ repo }) =>
    Process.exec({
      command: "git",
      args: ["diff", "--stat"],
      cwd: repo,
      timeoutMs: 60_000,
      maxOutputBytes: 65_536,
    }).pipe(Effect.map((result) => result.stdout)),
});
// Process.exec returns { exitCode, stdout, stderr, durationMs }
```

`command` names an installed executable and `args` are passed literally. For shell interpretation, invoke a shell explicitly, such as `command: "/bin/sh", args: ["-c", "..."]`. Effectory never installs executables during execution. `cwd` defaults to the host process's working directory, which may differ from the automation directory; set it explicitly for repository commands.

`env` accepts string values and extends the host environment by default; a command's variables are merged over the layer's. Set `extendEnv: false` to pass only those variables. `stdin` accepts text; omitted input is closed. The timeout defaults to 60 seconds and the combined stdout/stderr limit defaults to 64 KiB. Both limits must be positive integers. Output is collected concurrently and decoded as UTF-8; exceeding the byte limit fails instead of silently truncating a successful result.

Declare `error: Process.Failure` (`ProcessError | AutomationError`) on Tasks and workflows that run commands. Startup failures, stream/exit I/O failures, nonzero exits, timeouts, and output overflow produce `ProcessError` with a reason, message, nullable exit code, and bounded captured stdout/stderr. Invalid command input is an `AutomationError` with reason `invalid-input`. Cancellation retains Effect interruption semantics. Captured output becomes recorded data when a Task returns it, so commands should not print secrets.

Process scope cleanup sends SIGTERM to the process group and escalates after a one-second grace period if needed. Timeout and cancellation wait for cleanup; the timeout is an execution deadline, not an exact upper bound on the caller's total wait. Descendants that stay in the process group are covered, including after the leader exits. Processes that deliberately detach into another session are outside this ownership model. Cleanup relies on the configured Effect platform spawner; the current host targets macOS/Linux.

A forced runner kill cannot run scope cleanup. There is no background-process API. Use normal Effect concurrency for parallel commands. The runtime's JSON result/artifact bounds apply to what a Task returns, independently of the process byte limit.

## Run coding agents

`Agent` runs the Claude Code (`claude`) or Codex (`codex exec`) CLI for one non-interactive turn per call. Configure it once with a spec in `effectory.run.ts`:

```ts
// effectory.run.ts
import { Agent, Claude, Process } from "@effectory/activities";
import { Effectory } from "@effectory/sdk";
import { Layer } from "effect";

export default Effectory.make({
  services: Layer.mergeAll(
    Process.layer,
    Agent.make(
      Claude.make({
        model: "claude-sonnet-5-5",
        access: "read-only",
        pluginDirs: ["./.effectory/plugins/review"], // skills
        appendSystemPrompt: "You are an adversarial reviewer.",
      })
    )
  ),
  workflows: [reviewBranch],
});
```

Then call it from Tasks:

```ts
export const releaseNote = Task.make({
  name: "release-note",
  input: Schema.Struct({ diff: Schema.String }),
  success: ReleaseNote,
  error: Agent.Failure,
  run: ({ diff }) =>
    Agent.generate({
      prompt: `Write a release note for:\n\n${diff}`,
      schema: ReleaseNote,
    }).pipe(Effect.map((result) => result.value)),
});
```

- `Agent.run({ prompt })` returns the final answer as `output`. `Agent.generate({ prompt, schema })` returns `value`, decoded from the provider's schema-enforced channel (`claude --json-schema`, `codex exec --output-schema`). Nothing is parsed out of free text. Codex requires every property to be present, so model optional fields as `Schema.NullOr`. A call may override the spec's `model`, `effort`, `cwd`, and `access`, so one agent can review read-only while a single implementation Task writes.
- `Claude.make` and `Codex.make` validate their spec where it is made and throw on invalid settings. Each accepts `model`, `effort` (`low` to `max`), `access`, `addDirs`, `cwd`, `executable` (default `claude` or `codex` on `PATH`; never installed), `apiKeyEnv`, `timeoutMs` (default 10 minutes), and `maxOutputBytes`. Claude also accepts `appendSystemPrompt` and `pluginDirs`.
- `access` defaults to `read-only`: Claude gets only `Read`, `Grep`, and `Glob`, plus `Skill` when plugins are loaded; Codex runs in its `read-only` sandbox. `workspace-write` allows edits (Claude `acceptEdits`, Codex `workspace-write`). `none` runs Claude without tools; Codex has no such mode and its spec type rejects it. Claude's tool lists restrict the agent but are not OS isolation. Claude ignores configured MCP servers (`--strict-mcp-config`), and Codex ignores `config.toml`.
- Every result records provenance: provider, access, requested model, effort, reported models, session ID, cost, and duration. Codex reports no models, session, or cost on its final-message channel.
- Authentication uses the CLI's inherited environment or stored login. `apiKeyEnv` names a runner environment variable that is read when a call runs and passed as `ANTHROPIC_API_KEY` or `CODEX_API_KEY`; keys never appear in inputs or results.

Declare `error: Agent.Failure` on Tasks and workflows that call agents. A nonzero exit is a `ProcessError`. A Claude turn that reports an error, an unset `apiKeyEnv` variable, or a failure preparing Codex's temporary files is an `AgentError`. Output that does not match the expected shape or schema is an `AutomationError` with reason `invalid-output`. A crash before a Task's result is recorded repeats the paid call and any agent side effects, so use a stable key per logical call, and capture diffs in an earlier Task so replays review the same change.

To test Tasks without a CLI, provide a fake layer: `Layer.succeed(Agent.Service, Agent.Service.of({ spec, run, generate }))`. `.effectory/automations/review-branch` is a complete example: a diff Task, one reviewer per lens with `Workflow.each`, a pure verdict, an approval gate, and a release note.

## Run T3 Code threads

`@effectory/t3` exposes the [T3 Code](https://github.com/pingdotgg/t3code) `t3 thread` CLI as Tasks on the running local T3 server. Each operation is its own Task (`t3.thread.start`, `t3.thread.send`, `t3.thread.wait`, `t3.thread.show`, `t3.thread.list`) that runs the CLI with `Process.exec` and decodes its JSON inside the Task, so the journal records typed results. They require the `Process` layer. Start a thread, wait for its run, and follow up on the same thread:

```ts
import { Thread } from "@effectory/t3";

const thread =
  yield *
  Thread.start(
    {
      project: "7990cd94-6905-41df-9192-60b1076c376a", // T3 project id, or a path inside its main checkout
      message: "Review the staged changes and reply with a JSON summary.",
      title: "[effectory] review",
      provider: "claudeAgent", // requires model
      model: "claude-sonnet-5-5",
      worktree: { baseRef: "main", branch: "effectory/review" }, // optional
    },
    { key: "review" }
  );
// thread: { threadId, projectId, runId }

const reply =
  yield *
  Thread.wait(
    { thread: thread.threadId, runId: thread.runId },
    { key: "review" }
  );
// reply: { status, reply, needsInput, pendingRequestCount, runId, threadId }

const followUp =
  yield *
  Thread.send(
    { thread: thread.threadId, message: "Add a severity to each finding." },
    { key: "review-severity" }
  );
// followUp: { runId, messageId, status, delivery, threadId }; runId is null when queued
```

- `Thread.wait` polls `t3 thread show` inside one Task until the run reaches a final status, which it returns as data (`completed`, `failed`, `interrupted`, ...). It returns early with `needsInput: true` when the run waits for an answer, which someone gives in T3. A run replaced by a later run before it was observed settles with status `unknown`. `pollIntervalMs` defaults to 2 seconds; `waitTimeoutMs` bounds the whole wait (default 30 minutes) and fails with `Thread.ThreadWaitError`. A crash re-executes the read-only polling.
- `Thread.show` and `Thread.list` record a snapshot of a thread or a project's threads. Reusing a key replays the first snapshot; use a new key per observation.
- Messages are sent on stdin and flags use `--name=value`. Every Task accepts `executable` (default `t3` on `PATH`, which must have the `thread` command), `baseDir`, `cwd`, `timeoutMs`, and `maxOutputBytes`.

Declare `error: Schema.Union([Process.ProcessError, AutomationError, Thread.ThreadWaitError])` in the enclosing automation, or `Thread.ThreadActivityError` when the automation does not wait. CLI failures, such as a missing thread, are `ProcessError`s. Output that is not the expected JSON, including the CLI's help text or its exit-0 "no project matches" message, is an `AutomationError` with reason `invalid-output`.

Every invocation requires a key. Starting a thread and sending a message are not idempotent: a crash after T3 accepts the request but before Effectory records it repeats it on replay. The CLI does not yet expose runtime or interaction modes, so threads use the project's defaults, typically full access.

## Define an automation

`Automation.define` is the lower-level, imperative form behind `Workflow.make`. Use it when the step primitives cannot express a workflow; its body composes Tasks with Effect code and must supply a stable key for each Task call.

```ts
// .effectory/automations/greet/index.ts
import { Automation } from "@effectory/sdk";
import { Effect, Schema } from "effect";

import { greet } from "./tasks.ts";

export default Automation.define({
  name: "greet",
  description: "Prepare a greeting and request review",
  input: Schema.Struct({ requestId: Schema.String, name: Schema.String }),
  success: Schema.String,
  error: Schema.Never,
  idempotencyKey: (input) => input.requestId,
  execute: (input) =>
    Effect.gen(function* execute() {
      const message = yield* greet({ name: input.name });
      yield* Automation.publish("greeting", {
        schema: Schema.String,
        value: message,
      });
      yield* Automation.approve({
        key: "accept-greeting",
        title: "Accept the greeting",
        review: { message },
      });
      return message;
    }),
});
```

Input must be an Effect Struct schema. Effectory preserves its decoded input type, success type, domain error type, and native Workflow type. `execute` also receives the native run ID as its second argument. The name becomes the native Workflow identity. The CLI's request key remains the admission/deduplication key and is separate from the workflow's payload-derived idempotency key.

All schemas must have no encoding or decoding service requirements. Input admission remains bounded JSON; non-JSON decoded input is refused. Results and publications use each schema's JSON wire codec. BigInt becomes text, Date becomes ISO text, and Void becomes null. The default SQLite artifact backend enforces finite JSON and a 256 KiB limit.

The local host supplies Bun platform services, HTTP client, Effectory artifacts and approval services, and native workflow context. Activity and automation definitions preserve custom service requirements. Provide those services through the root entry point's layers or with `Effect.provide` inside the automation. `Effectory.make` checks the listed workflows against its configured services and the host services. Runtime module loading does not typecheck TypeScript. Run the repository typecheck in development and CI.

## Publish and approve

`Automation.publish(name, { schema, value, schemaVersion? })` validates and encodes a value, then writes an immutable artifact through its own native Activity. It returns no value. Use a distinct output name for each logical publication; repeated names replay the same completed publication. Schema versions default to 1. Inspect or retrieve artifacts through the existing CLI commands.

`Automation.approve({ key, title, review })` uses the host's durable approval service. The review must be bounded JSON. Approval is bound to the persisted review digest, task revision, and run. The helper returns an approved decision with operator/time metadata; rejection fails with `AutomationError` before the next effect. Cancellation and noninteractive review requirements remain enforced by the host. Code can catch an approval rejection explicitly if an alternative path is intended.

Each automation's native error schema includes its declared domain error and the schema-backed `AutomationError`. Framework errors carry `operation`, `message`, and one of `invalid-input`, `invalid-output`, `approval-rejected`, or `runtime`. Activity input/result validation, workflow result validation, output encoding, storage errors, and rejected approvals use this channel. Domain failures retain their declared error values. Defects and interruptions retain native semantics.

The manifest exposes `.workflow` and `.implementation` for native Effect interoperability. Existing raw Workflow manifests and `defineTask` remain supported. The SDK resolves from installed packages as well as local workspace packages. For external repositories, `bun run dogfood /path/to/repo` from the Effectory checkout installs local tarballs into an isolated `.effectory` project; see [setup](../README.md#dogfood-in-another-repository). Registry publishing remains a separate release action. New projects own their dependencies, Bun lockfile, and compiler config under `.effectory`; their authored source imports must stay inside `.effectory`. Installed SDK source bytes and package metadata participate in revision checks, including detection of dependency edits after registration. Other installed packages are assumed to match the lockfile.

## Embed the local runtime

Host applications can start a workspace without using the CLI:

```ts
import { startRuntime } from "@effectory/runtime";

const runtime = await startRuntime("/path/to/workspace");
try {
  const runs = await runtime.engine.listRuns();
  console.log(runs);
} finally {
  await runtime.close();
}
```

`startRuntime` initializes the workspace marker, loads its root workflow registrations, checks source revisions, and starts the owned engine and private Unix socket. The returned server exposes `workspace`, `socket`, `engine`, and `close()`. Close the server to release both socket and engine ownership; it preserves unfinished work for restart. Initialization is idempotent and refuses an incompatible workspace marker.

For a lower-level embedded engine with an explicit task catalog, runtime exports `openEngine` and `loadTaskCatalog`. `requestControl` sends typed requests to an already running workspace through the private socket. CLI argument parsing, terminal output, interactive confirmation, and OS signal handling remain in the CLI.

## Configure runtime services

`effectory.run.ts` at the workspace root declares all runnable workflows and their Effect service layers. The runner loads its default export automatically at startup. Use `Layer.empty` to keep local defaults without adding application services.

```ts
// effectory.run.ts
import { Effectory } from "@effectory/sdk";
import { Layer } from "effect";

import {
  DataStore,
  dataStore,
} from "./.effectory/automations/shared/data-store.ts";

export default Effectory.make({
  services: Layer.succeed(DataStore, dataStore),
  workflows: [greet],
});
```

`DataStore` here is an application-defined service, not a universal Effectory storage interface. For example, a small in-memory implementation for development:

```ts
// .effectory/automations/shared/data-store.ts
import { Context, Effect } from "effect";

export class DataStore extends Context.Service<
  DataStore,
  {
    readonly get: (key: string) => Effect.Effect<string | undefined>;
    readonly put: (key: string, value: string) => Effect.Effect<void>;
  }
>()("app/DataStore") {}

const values = new Map<string, string>();
export const dataStore = DataStore.of({
  get: (key) => Effect.sync(() => values.get(key)),
  put: (key, value) =>
    Effect.sync(() => {
      values.set(key, value);
    }),
});
```

Automations can `yield* DataStore` inside `execute`. Replace the configuration's layer to select a different implementation. Compose services using `Layer.mergeAll` and satisfy dependencies between them using `Layer.provide` or `Layer.provideMerge`. Services that acquire connections should use `Layer.effect` with `Effect.acquireRelease`; Effectory owns their scope and releases them when the runner closes or startup fails. The in-memory example above is ephemeral and does not survive process restarts.

Configuration layers can depend on the host's Bun platform services and HTTP client. Other dependencies must be supplied in the configured layer graph. `Effectory.make` checks those layer inputs, and `Automation.define` preserves custom service requirements in its registration layer. The `workflows` array brings those requirements into the same typed composition boundary: a listed workflow with an unprovided application service is a type error. Runtime loading still does not run TypeScript checks, so run typechecking in development and CI.

### Choose artifact storage

Effectory exports `ArtifactStore` from `@effectory/sdk`. Supply a layer for this service in `services` to replace artifact persistence. It has three operations:

- `publish({ runId, name, value, schemaVersion? })` returns an `ArtifactRecord`.
- `get(id)` returns an artifact or `undefined`.
- `list(runId?)` returns all artifacts, optionally filtered to one run.

All operations return Effects with `RuntimeError` failures. Both `Automation.publish` and the CLI's artifact inspection use the selected service. Artifact inspection loads the root entry point to select that service, so its imports must remain loadable. Run and approval inspection can still read local metadata without importing workflow code. When no custom `ArtifactStore` is provided, Effectory uses its existing SQLite implementation. This change provides the extension point; it does not ship a hosted storage adapter.

A backend must durably and atomically accept identical retries for a `(runId, name)` pair and reject different content or schema versions, including concurrent publications. Keep IDs stable and metadata consistent across reads. Published values arrive as schema-encoded JSON. Backend writes must tolerate replay after a crash between storing an artifact and recording activity completion. Artifact storage is separate from workflow results, runs, approvals, and the workflow journal, which still use local SQLite. Files written directly by activities are also unaffected.

### Configuration identity and restarts

Configuration is trusted executable code and follows the same static import restrictions as automations: explicit relative `.ts` imports, the supported SDK/Effect packages, and permitted builtins. Arbitrary third-party adapter packages are not yet supported by discovery; custom implementations can live in workspace source. Restart the runner after edits.

All workflows registered in `effectory.run.ts` share the fingerprint of that entry point and its complete transitive source graph. Editing the workflow list, service layers, or any imported workflow therefore changes the revision for every registered workflow. Changes are refused while unfinished runs require the previous revision. Environment variable values and remote backend state are not fingerprinted; keep backend identity stable while runs are unfinished. Selecting a new backend does not migrate existing artifacts.

Programmatic hosts can pass the same object as `openEngine({ workspace, tasks, config })`. They own task revision identity; `openEngine` itself does not discover or fingerprint configuration files.

### Migrating directory discovery

Workspaces without `effectory.run.ts` retain the legacy `.effectory/automations/<name>/index.ts` discovery behavior, optionally with service layers in `effectory.config.ts`. To migrate, move those services into `effectory.run.ts` and explicitly import and list every runnable definition in `workflows`. Remove `effectory.config.ts`; having both files is rejected. `workflows: []` intentionally registers no workflows and does not fall back to directory discovery. Native manifests must supply a `name` when listed explicitly.

Finish existing runs before migrating: changing the entry point changes the revision, and Effectory refuses to resume unfinished runs under the new revision.

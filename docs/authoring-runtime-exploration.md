> Historical exploration, superseded by [the selected graph model](authoring-runtime.md).

# Authoring runtime: public API candidates

Status: API design for review, not an implemented package. Present the `Effect.gen` model first. It is **not selected** over the earlier graph proposal. The question is whether a workflow is primarily an executable program or an inspectable specification. Both can use Effect to execute tasks.

This document scopes the author-facing surface: declare tasks, implement them, compose workflows, publish data and wait for external input. Daemon startup, RPC transport, extension installation and storage configuration are host APIs. The entry point and runner lifecycle are introduced in [Customer applications and the edge runner](edge-runtime.md). That proposal adds `.implement(handler)` as a convenience pairing the spec and handler Layer; `.toLayer(handler)` below remains the lower-level API. Names below are proposed `@effectory/core` exports. Code examples are illustrative, not typechecked implementations.

Follow-up: [Five authoring APIs](authoring-api-options.md) adds an Alchemy-inspired generator that constructs a graph. The direct-execution generator below is one particular interpretation of Effect.gen, not its only possible use.

## 1. Effect.gen first

A task declares its boundary. Its implementation is a Layer. A workflow declares another boundary and supplies an Effect program that calls tasks.

```ts
import { Task, Workflow } from "@effectory/core";
import { Effect, Layer, Schema } from "effect";

const FetchRelease = Task.make("releases/fetch", {
  version: 1,
  input: Schema.Struct({ repository: Schema.String }),
  success: Schema.Struct({ version: Schema.String }),
  error: Schema.Struct({
    _tag: Schema.Literal("ReleaseUnavailable"),
    message: Schema.String,
  }),
  replay: "idempotent",
});

const FormatRelease = Task.make("releases/format", {
  version: 1,
  input: Schema.Struct({ version: Schema.String }),
  success: Schema.Struct({ text: Schema.String }),
  error: Schema.Never,
  replay: "idempotent",
});

const ReleaseSummary = Workflow.make("releases/summary", {
  version: 1,
  input: FetchRelease.inputSchema,
  success: FormatRelease.successSchema,
  error: FetchRelease.errorSchema,
});

const ReleaseSummaryLive = ReleaseSummary.toLayer((input) =>
  Effect.gen(function* () {
    const release = yield* FetchRelease.call("fetch", input);
    return yield* FormatRelease.call("format", release);
  })
);

const FormatReleaseLive = FormatRelease.toLayer(({ version }) =>
  Effect.succeed({ text: `Release ${version}` })
);

// FetchReleaseLive supplies the real API integration. Its dependencies, such
// as an HTTP client and SecretStore, are provided by the application.
const ReleaseTasksLive = Layer.mergeAll(FetchReleaseLive, FormatReleaseLive);
const ReleaseProgramLive = ReleaseSummaryLive.pipe(
  Layer.provide(ReleaseTasksLive)
);
```

`FetchReleaseLive` above is an intentionally omitted integration, not a built-in. Nothing executes when specs or Layers are declared. The host builds the Layers and submits a run. `.call` is a durable call **inside a workflow**, not a top-level submission API and not a direct invocation of the task function.

The string `"fetch"` identifies an invocation within the workflow. The task ID `"releases/fetch"` identifies a reusable contract. Calling one task twice needs two invocation keys. The runtime combines run ID, nested scope, invocation key and pinned contract revision to identify the recorded operation.

### What this buys us

Inputs and results are ordinary decoded TypeScript values. Sequential `yield*` establishes ordering; ordinary `if` selects a branch. Effect's `forEach` supports bounded parallel calls without adding a second concurrency language:

```ts
const releases =
  yield *
  Effect.forEach(
    repositories,
    (repository) => FetchRelease.call(`fetch:${repository}`, { repository }),
    { concurrency: 4 }
  );
```

Here repository names must be unique, canonical stable keys, and the collection must come from pinned input or a recorded task result. Position-based keys are unsafe when collection membership/order can change. The runtime rejects repeated keys in one evaluation, including concurrent repeats. During replay, a previously recorded key must have the same target, input fingerprint and invocation options.

### Where this stops being an inspectable spec

The workflow body is arbitrary JavaScript. Reading its input/output schemas does not reveal its steps, possible branches, dependency edges or dynamically chosen tasks. A dry run with fake values cannot discover all possible execution paths. The runtime can record an execution graph, but that describes a particular run. It is not a complete pre-execution workflow definition.

A handler Layer can replace `FetchRelease` everywhere the host selects it. Replacing the particular `"fetch"` invocation requires a host routing override that is checked when that invocation is reached. Inserting a step between fetch and format, rewiring an edge or validating every possible target before execution requires changing the program or imposing a restricted workflow language.

The generator's local variables and instruction pointer are not persisted. Recovery re-enters the pinned program and returns recorded operation outcomes. Ordinary code between durable boundaries can run again. Network calls, time, randomness and lake queries affecting control flow belong in recorded tasks. TypeScript's `Effect<A, E, R>` does not prove that an effect is deterministic or that it will never perform an unrecorded side effect.

## 2. Shared primitives, independent of workflow syntax

These contracts can survive choosing either authoring model.

### Task

`Task.make(id, options)` is pure and returns an immutable spec with literal ID and version, `inputSchema`, `successSchema`, `errorSchema`, output declarations and execution policy. Version is a positive integer. Version participates in handler identity; two contract versions cannot share a Context key accidentally.

Required options are `version`, `input`, `success`, `error`, and `replay`. Requiring even `Schema.Void`/`Schema.Never` keeps published boundaries explicit. Optional options are `description`, `outputs` and `retry`. Initial replay policies are `idempotent` and `manual`. Reconciliation will need a separately specified handler contract; a string flag alone is insufficient to implement it.

All boundary schemas must encode/decode without service requirements in v0. Author APIs use `S["Type"]`; persistence and RPC use the JSON-compatible encoded representation. Reject service-dependent codecs and unsupported encodings during spec validation. An encoded representation need not equal its decoded type. JSON Schema export describes discovery only; it does not transport codec code.

Conceptual signatures, with overloads and type markers omitted:

```ts
// I, O, E are decoded schema types; Id and V are literal identity parameters.
interface TaskSpec<Id, V, I, O, E> {
  toLayer<R>(
    handler: (input: I) => Effect.Effect<O, E | ExecutionError, R>
  ): Layer.Layer<TaskHandler<Id, V>, never, Exclude<R, TaskContext>>;

  // Available only in the Effect-program workflow candidate.
  call(
    key: string,
    input: I
  ): Effect.Effect<O, E | ExecutionError, WorkflowContext | TaskHandler<Id, V>>;
}
```

The task adapter provides a fresh TaskContext per attempt. The Layer must retain all other requirements. Handler service dependencies are satisfied at Layer build time and captured by the implementation; callers depend on its handler service, not on every transitive HTTP/database dependency. The host supplies the engine and persistence requirements through WorkflowContext when it executes a run.

V0 `.toLayer` accepts a handler function. Resource acquisition uses `Layer.effect` with scoped Effects or an Effect-valued group builder as described below; it must not occur inside a pure spec constructor. Resources are owned by the scope of the built Layer.

`ExecutionError` is a fixed, schema-defined runtime error union, separate from the task's domain error schema. It includes artifact/storage failure, timeout and invocation conflict. A handler may propagate those failures from runtime services without expanding every task's domain contract. The persisted run envelope distinguishes domain failure from execution failure. Invalid success values, defects and cancellation are also recorded distinctly; they are not silently cast to `E`. Neither candidate treats cancellation as a successful result.

Task handlers cannot call other tasks or wait for workflow signals in v0. Compose those operations at workflow level to preserve visible activity boundaries. Handlers may use normal Effect services, resource scopes, logging and tracing. No service object, function, open handle or fiber can be returned as a durable result.

### TaskGroup

`TaskGroup.make(...tasks)` collects contracts. `.add` and `.merge` return new groups. `.toLayer(handlers)` requires exactly one handler for each contract, infers input/result/error types and retains the handlers' service requirements. It also accepts an `Effect` producing the handler map to capture shared services:

```ts
const ReleaseTasks = TaskGroup.make(FetchRelease, FormatRelease);

const ReleaseTasksLive = ReleaseTasks.toLayer(
  Effect.gen(function* () {
    const releases = yield* ReleaseClient;
    return {
      "releases/fetch": ({ repository }) => releases.latest(repository),
      "releases/format": ({ version }) =>
        Effect.succeed({ text: `Release ${version}` }),
    };
  })
);
```

Here `ReleaseClient` is an application-defined Context service whose `latest` operation has FetchRelease's success/error types. Its acquisition errors and requirements remain in the resulting Layer. A group contains only one version per task ID so handler map keys remain unambiguous. Different groups may expose separate versions using versioned handler identities. Installing the same identity twice is an error; replacement is an explicit host selection.

Shared configuration is an application service supplied through Layers. Do not add another ambient configuration mechanism to TaskGroup. A separately named, persisted configured-instance API can be designed when its identity and revision requirements are specified.

### TaskContext

The runtime supplies an immutable context for a task attempt:

- `runId`, `invocationPath`, `taskId`, `taskVersion` and `attempt` for provenance.
- `idempotencyKey`, stable across retries of one invocation, for external APIs.
- `publish(outputName, value, { key })` for declared JSON outputs, returning a schema-branded exact ArtifactRef. Output-name and value types derive from the task spec. The write key is stable within the invocation, not attempt-specific.
- `progress({ message, completed?, total? })` for bounded, sanitized progress events. Progress is observational; replay may repeat an update.

Access is spec-specific: `yield* FetchRelease.context` has the output map declared by FetchRelease. There is no untyped global `publish(anySchema, anyValue)` escape hatch. Acquiring another task's context fails validation at execution. Progress reporting is best-effort and cannot turn a successful business operation into a failure. Publication is durable and may fail with ExecutionError.

Use a separate typed Lake service inside a task to query existing data. It returns concrete versions; persist the query result as a task result when later workflow control flow depends on it. Secret resolution likewise belongs in a service, not plaintext configuration or a journaled context field.

### Artifact

`Artifact.make(id, { version, schema, retention? })` defines JSON data; its content type is `application/json`. `.refSchema` describes an exact reference with artifact ID, data version, schema identity and digest. It validates the reference shape; actual existence/digest checks happen when the lake reads it. File/stream artifact authoring is a separate API to define next.

```ts
const Summary = Artifact.make("releases/summary", {
  version: 1,
  schema: Schema.Struct({ text: Schema.String }),
});

const SaveSummary = Task.make("releases/save-summary", {
  version: 1,
  input: Summary.schema,
  success: Summary.refSchema,
  error: Schema.Never,
  outputs: { summary: Summary },
  replay: "idempotent",
});

const SaveSummaryLive = SaveSummary.toLayer((value) =>
  Effect.gen(function* () {
    const context = yield* SaveSummary.context;
    return yield* context.publish("summary", value, { key: "result" });
  })
);
```

Task success does not implicitly publish declared artifacts. Declaring an output permits a handler to publish that type; it does not require one write. Reusing a publication key with identical encoded content returns the prior reference; different content conflicts. Result and publication are separate durable records.

## 3. Workflow and waits in the Effect candidate

`Workflow.make(id, { version, input, success, error, description? })` defines a contract. `.toLayer(handler)` accepts an Effect program with the same decoded input/output rules as a task. It provides WorkflowContext and retains handler and other service requirements. Arbitrary dependencies are technically possible; only deterministic orchestration is replay-safe. This limitation must remain visible in the documentation rather than hidden behind a TypeScript type.

`WorkflowGroup.make(...workflows)` follows TaskGroup's grouping and handler-map rules. `.call(key, input)` invokes and awaits a pinned child workflow, with its own invocation scope and cancellation linked to the parent. Root submission and background detachment are host operations; they are not `Effect.fork` in an author program. V0 has no detached child author API.

The candidate WorkflowContext exposes:

| Operation | Public shape | Durable meaning |
| --- | --- | --- |
| Delay | `context.sleep(key, duration)` | Persist the wake-up deadline; replay uses it |
| External input | `context.awaitSignal(key, SignalSpec, { timeout })` | Persist a typed wait, suspend and resume on a recorded value |
| Approval | `context.approve(key, { prompt, timeout })` | Persist a Boolean decision and authenticated actor |

`Signal.make(id, { version, payload })` declares a reusable signal payload schema. Delivery is a host API addressed to run ID and wait ID, not a process-local queue. Timeout is an ExecutionError; denial returns `false` so the workflow handles it explicitly. Duplicate identical decisions are idempotent; conflicting decisions fail. A wait key shares the invocation namespace with task, child and timer keys.

```ts
const ApprovedSummaryLive = ReleaseSummary.toLayer((input) =>
  Effect.gen(function* () {
    const context = yield* ReleaseSummary.context;
    const release = yield* FetchRelease.call("fetch", input);
    const approved = yield* context.approve("review", {
      prompt: `Publish release ${release.version}?`,
      timeout: "24 hours",
    });
    if (!approved) return { text: "Publication declined" };
    return yield* FormatRelease.call("format", release);
  })
);
```

This is an alternative implementation, not a second Layer to install beside ReleaseSummaryLive. Approval does not itself publish anything.

`Retry.make({ maxAttempts, initialDelay, factor, maxDelay, jitter, retryOn })` declares an inspectable, bounded policy. `retryOn` lists domain-error tags; untagged domain errors are not automatically retried in v0. It attaches to a task spec or a graph node, not a blanket `Effect.retry` around the whole workflow. The runtime persists attempts and chosen backoff deadlines. `manual` replay policy never permits retry of an uncertain side effect without operator review. Ordinary Effect retry inside a task belongs to that one attempt and does not add separate durable attempts.

## 4. The same workflow as a specification

The alternative retains all the task/artifact contracts but makes workflow composition a pure definition. The following refines the earlier graph sketch:

```ts
const ReleaseSummary = Workflow.make("releases/summary", {
  version: 1,
  input: FetchRelease.inputSchema,
  success: FormatRelease.successSchema,
  error: FetchRelease.errorSchema,
  build: (flow) => {
    const release = flow.task("fetch", FetchRelease, flow.input);
    const summary = flow.task("format", FormatRelease, release.output);
    return flow.succeed(summary.output);
  },
});

const ReleaseSummaryLive = ReleaseSummary.toLayer().pipe(
  Layer.provide(ReleaseTasksLive)
);
```

Here `flow.input` and `release.output` are typed references, not runtime values. The builder is evaluated once during compilation. It must be pure and stable; its returned graph is validated and frozen. Conditional execution uses an explicit `flow.branch` node, not JavaScript `if` on a reference. Fan-out uses an explicit collection reference, stable item key expression and concurrency limit. Pure transforms need a defined expression vocabulary or a named transform task. The full branch/expression API is deliberately not frozen in this comparison.

The host can inspect task targets, declared dependencies, schemas and stable node IDs before submitting a run. It can apply a patch such as replacing the `"fetch"` node or inserting an approval, then validate the resulting graph before activation. An override is part of a new pinned workflow revision. Dynamic fan-out still expands only when its input is known; static inspection describes its template rather than pretending to know all concrete nodes in advance.

This model is stricter for authors but directly supports the original requirement that extensions override pieces of the workflow. Task implementations still use Effect.gen and service Layers. Choosing a graph does not require abandoning Effect-native execution or schema-first contracts.

## 5. Decision for the next API pass

Keep Task, TaskGroup, Artifact, typed contexts and Layer implementations common. Keep the two Workflow signatures separate until an authoring model is selected; do not ship an overloaded API that quietly accepts both with different guarantees.

The decisive example is an extension that must insert an approval **between two existing workflow steps** without editing the workflow's source. A named-task replacement alone is insufficient. If that is a core authoring requirement, the graph model is the stronger default and Effect.gen is the task implementation language. If extensions mostly replace providers or whole task implementations, an Effect program can be sufficient and offers simpler composition.

Neither model has been implemented or accepted by this document. Next, define the graph's Step, reference expressions, branch/fan-out and patch contracts if pre-execution inspection and structural overrides are required.

## Source basis and future checks

The pinned [RpcGroup](../vendor/effect/packages/effect/src/rpc/RpcGroup.ts) grounds spec grouping and handler Layers. [Workflow](../vendor/effect/packages/effect/src/workflow/Workflow.ts) and [Activity](../vendor/effect/packages/effect/src/workflow/Activity.ts) ground Effect program execution and recorded operations. Activity explicitly warns that suspended bodies may run again. [DurableClock](../vendor/effect/packages/effect/src/workflow/DurableClock.ts) defaults short sleeps to memory; the Effectory durable-delay adapter must select the persistent path rather than inherit that threshold accidentally.

Once implemented, type fixtures must check wrong input/result/error types, undeclared output names, retained service requirements, unsatisfied handler Layers and versioned handler identities. Runtime tests must cover changed inputs under a reused invocation key, duplicate concurrent keys, replay without rerunning completed tasks, publication deduplication, interrupted waits and invalid outputs. A generator test cannot establish static graph completeness.

# Graph composition and execution policies

Status: planning pass 1 of 5. These are proposed additions to the [selected authoring model](authoring-runtime.md), not accepted or implemented APIs. No examples have been typechecked. The goal is a small, coherent vocabulary that lets consumers express real workflows while retaining pre-run inspection.

Keep `Task.make(spec, handler)` and `Workflow.make(spec, constructionEffect)`. Keep `yield* Workflow.Builder`. Graph methods register nodes; they never execute task work while constructing a graph. Runtime scheduling follows dependencies.

## Recommendation

Use opaque references, ordinary object/array literals containing references, explicit field selection, and a small set of graph nodes:

| Operation | Purpose | Construction result |
| --- | --- | --- |
| `graph.input(schema)` | Bind the declared workflow input schema | `Ref<Input>` |
| `Ref.field(ref, key)` | Select a field without executing code | `Ref<Field>`; not an Effect |
| `graph.task(id, task, input, options?)` | Invoke a reusable task | Effect yielding `Ref<Success>` |
| `graph.map(id, { input, success }, fn)` | Record a small pure computation | Effect yielding `Ref<Success>` |
| `graph.branch(id, condition, cases)` | Choose one declared subgraph | Effect yielding `Ref<Success>` |
| `graph.forEach(id, items, options, build)` | Instantiate a bounded item subgraph | Effect yielding `Ref<ReadonlyArray<Success>>` |
| `graph.workflow(id, workflow, input, options?)` | Invoke a reusable workflow | Effect yielding `Ref<Success>` |
| `graph.sleep(id, duration, options?)` | Await a persisted deadline | Effect yielding a completion reference |

The existing approval, input-request and signal proposals use the same reference, scope and ordering rules. Independent nodes already run concurrently; a separate `parallel` operator is unnecessary. Data references join results naturally.

## The input typing adjustment

The existing `graph.input` property is not proven to have the workflow's input type. An independently constructed `Effect.gen` looks up one globally typed `Workflow.Builder` service. The first argument to a later `Workflow.make` call cannot be assumed to specialize that service inside the generator.

**Proposed adjustment:** make input access `yield* graph.input(InputSchema)`. The schema is named once and reused in the spec. It supplies the generic type at the point where inference needs it. Graph validation must require that this is the exact declared input codec, not merely another codec with an assignable Type. Within the loaded bundle, retain the actual codec identity for this check.

This adds one line and changes the earlier property syntax; it requires approval as an API adjustment. It preserves the selected two-argument constructor and Effect-based construction. A future schema-bound builder could remove repetition, but must demonstrate sound inference before replacing this explicit design.

Do not use an unchecked `graph.input<T>()`, cast through `any`, or claim arbitrary schemas are equivalent because their TypeScript types match. A mismatched input codec must fail graph construction before activation. A prototype should also investigate carrying the requested codec requirement through the construction Effect to reject mismatches statically; runtime identity checking remains required.

## A complete authoring shape

The imported tasks are hypothetical definitions with these contracts: FetchRelease accepts `{ repository }` and returns `{ version, notes }; PublishSummary accepts `{ repository, markdown, channel }`and returns a URL. Their error schemas are included in`ReleaseError`.

```ts
import { Ref, Workflow } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

import { FetchRelease, PublishSummary, ReleaseError } from "./tasks";

const Input = Schema.Struct({ repository: Schema.String });

export const ReleaseSummary = Workflow.make(
  {
    id: "release-summary",
    version: 1,
    input: Input,
    success: Schema.String,
    error: ReleaseError,
    execution: { concurrency: 4, timeout: "1 hour" },
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const input = yield* graph.input(Input);
    const release = yield* graph.task("fetch", FetchRelease, input);
    const markdown = yield* graph.map(
      "render",
      { input: release, success: Schema.String },
      ({ version, notes }) => `# ${version}\n\n${notes}`
    );
    const approval = yield* graph.approval("review", {
      prompt: "Publish this release summary?",
      context: markdown,
      timeout: "30 minutes",
    });

    return yield* graph.task(
      "publish",
      PublishSummary,
      {
        repository: Ref.field(input, "repository"),
        markdown,
        channel: "releases",
      },
      { after: [approval], timeout: "2 minutes" }
    );
  })
);
```

`execution` and task `timeout` are proposals described below. This example does not hide a configured integration instance; task services still come from Layers.

## Reference and boundary semantics

`Ref<T>` is opaque and carries graph/node identity. It is neither `T` nor an Effect that yields `T`. Property access on the eventual value is explicit through `Ref.field`; there is no proxy exposing `release.version` as a pretend string. Nested selection composes field selectors. Optional fields preserve optionality.

Inputs and workflow returns accept a whole reference, a literal value, or plain struct/array/tuple values containing references. An `InputOf<A>`-style mapped type must preserve optional fields, readonly arrays and discriminated unions; its exact definition is prototype work. Do not recursively map arbitrary class instances, functions or service values. Non-plain decoded values use a whole reference or an explicit mapping node and an appropriate boundary codec.

Resolve all references before validating a task input. Persist producer values with their output codecs; reconstruct values with those codecs, assemble the consumer input, and validate/encode it with the consumer's codec before dispatch. Type assignability alone does not prove codec compatibility, particularly with refinements or transformations. Do not silently feed one codec's encoded wire representation into an unrelated codec expecting a different decoded value.

Any reference contributes a dependency. `after: [ref]` adds a successful-completion dependency without passing data. Completion tokens from approval/sleep are valid `after` dependencies but cannot be forged from a task's ordinary result.

Returning a value selects the workflow result and checks it against the success schema; it does not discard other declared work. Success requires all activated nodes in that scope to finish. Unselected branch nodes are inactive. An unrelated active node's failure still fails the workflow. Detached/fire-and-forget nodes are outside v0. Cross-workflow references and references escaping a branch/item scope are graph errors even if TypeScript cannot detect them.

## Pure transformations

`graph.map` receives resolved values at execution time. Its synchronous function must be deterministic, bounded and free of I/O, time, randomness or service access. It may capture immutable configuration pinned with the application, not live mutable objects. Encode its output with `success` and persist it before downstream nodes proceed. A crash before that commit may execute the function again.

Pinning code does not enforce purity. A throw or invalid output is a definition/ execution defect; anticipated business failures belong in a Task with an error schema. Awaitable/Effect results are rejected. The stable node ID identifies the function in the pinned bundle; do not serialize a closure or promise remote portability from the graph's JSON representation alone.

## Branching

```ts
const result =
  yield *
  graph.branch("publish-mode", isPreview, {
    success: PublishResult,
    onTrue: Effect.gen(function* () {
      const branch = yield* Workflow.Builder;
      return yield* branch.task("preview", PreviewSummary, summary);
    }),
    onFalse: Effect.gen(function* () {
      const branch = yield* Workflow.Builder;
      return yield* branch.task("publish", PublishSummary, summary);
    }),
  });
```

Here `isPreview` is `Ref<boolean>` and the two tasks accept the illustrative `summary` input. Both Effects build their child graphs at application load. Only the selected child graph activates at runtime; persist the selection once. The shared `success` codec validates either result. Use an explicit union schema for different result variants instead of relying on fragile branch-union inference. Parent references may enter a child; child references leave only via its result.

V0 branches on a Boolean success value, not errors or approval permits. A normal task can produce a business decision. Rejected/TimedOut gate outcomes retain the existing run-termination policy. Exhaustive tagged matching and recovery branches can follow after this simple scoped operator is proven.

## Bounded fan-out and nesting

```ts
const deployments =
  yield *
  graph.forEach(
    "deploy-targets",
    targets,
    {
      item: Target,
      success: Deployment,
      key: (target) => target.id,
      concurrency: 3,
      maxItems: 100,
    },
    (target) =>
      Effect.gen(function* () {
        const item = yield* Workflow.Builder;
        return yield* item.workflow("deploy", DeployTarget, target);
      })
  );
```

`targets` is a reference to an array; `Target` and `Deployment` are codecs. The callback receives `Ref<Target>` and constructs one item template at load time. At runtime, decode and snapshot the entire collection, validate its bounded size, compute stable nonempty string keys, and reject duplicates before starting items. Persist the key/order expansion so restart neither repeats discovery nor changes identities. Keys come from domain identity, never array indices or randomness.

Results preserve the captured input order. Empty input succeeds with an empty array. An unhandled item failure stops admitting new items and interrupts siblings under the normal finalization contract; prior external effects remain. V0 does not stream infinite collections or provide all-settled mode.

`graph.workflow` is a linked child invocation with namespaced identity, the pinned child definition, its own input/output codecs and inherited cancellation. It produces a result only when the child settles successfully. Child workflows may be nested but recursive definition cycles are rejected initially. Reusable plain construction helpers are also possible, but callers must supply unique node IDs.

## Execution policies

| Attachment | Proposed policy | Meaning |
| --- | --- | --- |
| Workflow spec `execution` | `concurrency`, `timeout` | Leaf-task limit and overall deadline for this invocation |
| Task invocation options | `after`, `retry`, `timeout`, `attemptTimeout` | Ordering, task retries, total node deadline, individual attempt limit |
| Child workflow options | `after`, `timeout` | Ordering and invocation deadline; no whole-child retry in v0 |
| Fan-out options | `concurrency`, `maxItems` | Active item scopes and bounded expansion |
| Wait options | Existing required `timeout`, optional `after` | Deadline begins when the wait opens |

For example, task retry may be `{ attempts: 3, delay: "1 second", when: ["RateLimited"] }`. Attempts includes the initial attempt; `when` selects declared tagged domain errors. Default is one attempt, not automatic retries of every failure. Persist the retry decision and absolute next-attempt time. Crash reconciliation follows the task's replay policy and is distinct from retrying a recorded failure. Automatic retry is rejected for tasks whose replay/reconciliation contract cannot safely support it.

A workflow timeout begins when its invocation starts, excluding admission queue time. A task's total timeout begins once dependencies are satisfied, includes scheduler queueing/backoff, and never resets on retry. Attempt timeout begins when that attempt starts. Intersect child and ancestor deadlines; a child cannot extend its parent's lifetime. Timeout requests interruption and bounded finalization; uncertain external effects may require NeedsAttention instead of invented completion.

Concurrency limits count running leaf tasks across nested children, not waiting gates or control nodes. Child controllers must not hold a parent task permit while waiting for descendants. Fan-out's limit counts active item scopes, so an item waiting for approval still occupies an item slot but no worker slot. Per-task global rate limits and fairness classes are separate host policy, deferred here.

`graph.sleep` always uses a persisted deadline, including short delays. The pinned [DurableClock](../vendor/effect/packages/effect/src/workflow/DurableClock.ts) has a short-duration in-memory path; the adapter must deliberately select persistent behavior. [Activity](../vendor/effect/packages/effect/src/workflow/Activity.ts) records completed outcomes but warns that suspended bodies can rerun, so side effects and waits must remain separate node boundaries.

Effect's Schedule is useful inspiration, but arbitrary Schedule values may contain services, clocks or closures. V0 accepts the bounded retry policy above. A later Effect Schedule adapter must define supported schedules and persisted state before claiming durability. `Effect.all`, `Effect.retry` and `Effect.timeout` around graph construction still operate only on construction.

## Minimum scope and required proof

The minimum useful language is task/input/reference composition, map, Boolean branch, bounded keyed forEach, linked workflow, explicit after, durable sleep and the three wait primitives. Defer pipeline sugar, implicit IDs, arbitrary loops, race, all-settled, error recovery combinators, arbitrary Schedule and detached runs.

Before committing the runtime, prove these with a small type/API prototype:

1. Schema-bound input inference survives an independently assigned construction Effect; incompatible codecs are refused without `any` or unchecked casts.
2. Mixed literal/reference inputs reject wrong fields and preserve optional fields, unions and readonly collections. Codec transforms survive persistence and edges.
3. Branch return mismatch reports the offending branch; every case validates the explicit success codec. Escaping and cross-graph refs fail before activation.
4. Task error requirements and service requirements remain visible through nested construction. The declared workflow error schema must cover escaping task errors; dynamically loaded providers require runtime enforcement too.
5. A workflow returning early still waits for all activated nodes; inactive branches never execute. Keyed expansion and branch choices survive restart unchanged.
6. Retry/deadline semantics survive restart; parent/child concurrency does not deadlock, and waiting branches release execution capacity.

The principal consumer tradeoffs to review are explicit schema-bound input access, schema-annotated pure mapping, and small declarative retry policies rather than unrestricted Effect Schedule. None of those tradeoffs has been accepted yet.

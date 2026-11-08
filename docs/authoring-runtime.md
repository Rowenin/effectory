# Authoring runtime: selected graph model

Status: the user selected graph-based workflows. The runtime is not implemented; the detailed types and control-node APIs still need prototyping. This document supersedes the [earlier exploration](authoring-runtime-exploration.md).

## Accepted API direction

```ts
Task.make(spec, handler);
Workflow.make(spec, constructionEffect);
```

Both take the spec as the first argument, including its ID, and the implementation as the second. No chained `.implement` or `.build` is required for authoring. Task handlers perform work; workflow construction Effects declare a graph. Definitions retain schemas and handler Layers for application registration.

```ts
const RenderSummary = Task.make(
  {
    id: "releases/render",
    version: 1,
    input: Schema.Struct({ version: Schema.String, notes: Schema.String }),
    success: Schema.Struct({ markdown: Schema.String }),
    error: Schema.Never,
    replay: "idempotent",
  },
  ({ version, notes }) =>
    Effect.succeed({ markdown: `# ${version}\n\n${notes}` })
);

// FetchRelease is an imported task definition with a compatible result schema.
const ReleaseSummary = Workflow.make(
  {
    id: "release-summary",
    version: 1,
    input: FetchRelease.inputSchema,
    success: RenderSummary.successSchema,
    error: FetchRelease.errorSchema,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const release = yield* graph.task("fetch", FetchRelease, graph.input);
    return yield* graph.task("render", RenderSummary, release);
  })
);
```

Imports are `Effect` and `Schema` from `effect`, and `Task` and `Workflow` from `@offtree/effectory-sdk`. These are design examples, not working exports.

## Construction and execution

`graph.task` returns an Effect that registers a named node and returns a typed reference to its eventual result. It does not perform the task. A node handle is a reference itself, with no extra `.output` property. Passing a reference as task input creates an execution dependency. Returning a reference selects the workflow result. Invocation IDs are distinct from reusable task IDs.

Effect concurrency, retry, timeout and resource-scoping operators applied to the construction Effect govern construction only. In particular `Effect.all` does not set task concurrency, and `Effect.retry(graph.task(...))` does not retry task work. Independent declared nodes can execute concurrently regardless of declaration order. Execution ordering without data flow needs an explicit graph edge.

Execution policies may reuse Effect concepts such as Schedule, but the runner must interpret them durably and persist attempts/deadlines. The policy attachment API has not been selected. Runtime branching, fan-out, approvals, input requests and delays require graph nodes; ordinary JavaScript cannot inspect unresolved results.

Construction is required to be deterministic and free of external side effects. Effect typing does not enforce purity. Functions attached to runtime transform nodes need stable identity, validated output and replay rules; pinning a bundle alone does not make arbitrary closures safe or portable.

## Consumer and runner contract

Customers export `Application.make({ tasks, workflows })` from `effectory.ts` and supply application-specific services through Layers. The runner constructs and validates the graph before accepting work, selects providers, then executes a pinned application revision for each run. A missing registered task is a validation error; it is never implicitly downloaded.

Task success/error and persisted/RPC/input boundaries use Effect Schema. Task implementations retain their unresolved service requirements. Configured behavior instances, convenience defaults, inferred step IDs and testing helpers from the review remain suggestions, not accepted APIs.

## Next API work

The focused [graph composition](graph-composition.md) and [task implementation](task-implementation.md) passes now propose concrete answers to these questions. They are review candidates, not changes already accepted: notably `graph.input(InputSchema)` and a typed `(input, context)` task handler. The original examples above retain the selected direction and still need the type proofs described in those proposals.

- Define graph references and input typing, particularly how the typed workflow input reaches `Workflow.Builder` through an independently built Effect. The snippets do not prove that inference; avoid hiding it behind `any`.
- Define runtime branches, fan-out, transforms and explicit ordering.
- Define durable execution policies independently from construction policies.
- Review the three [interaction proposals](pausing-and-input.md#three-public-api-proposals): approval gates, schema-backed user input and one-shot external signals.
- Prototype useful TypeScript errors and schema validation before implementation.

The [five alternatives](authoring-api-options.md) and [Claude review](authoring-api-review-claude.md) remain historical decision context. The selected approach combines an explicit builder service with Effect-based construction; it is not exactly the plain callback in the original Option 3.

# Specification-driven API

> Decision update: graph workflows with Effect-based construction are now selected. `Task.make(spec, handler)` and `Workflow.make(spec, constructionEffect)` replace the earlier chained constructor sketches below. See the [current authoring API](authoring-runtime.md). Alternative syntax and undecided-status statements below describe the earlier exploration.

For the next API pass, see [Authoring runtime: public API candidates](authoring-runtime.md). That document makes task declarations, handler Layers, execution contexts and waits more concrete, and compares Effect.gen with the graph sketch below. Both remain proposals; the generator model has not replaced this graph proposal. The [application entry-point proposal](edge-runtime.md) adds `.implement` and `Application.make` to make runner registration straightforward for consumers.

## Contract, implementation, runtime

`Thing.make()` constructs an immutable specification without starting work or opening resources. A spec carries stable identity, schemas, documentation and policy metadata. `.toLayer(handler)` binds an implementation. Groups compose specs; the runtime validates and installs their implementation Layers.

This is modeled on Effect's real [RpcGroup tests](../vendor/effect/packages/effect/test/rpc/Rpc.test.ts) and [Workflow.toLayer](../vendor/effect/packages/effect/src/workflow/Workflow.ts). All `@effectory/*` names below are **proposed APIs**, not existing exports.

```ts
import { Artifact, Task, TaskGroup } from "@effectory/core";
import { Effect, Schema } from "effect";

const Greeting = Artifact.make("example/greeting", {
  version: 1,
  schema: Schema.Struct({ text: Schema.String }),
});

const Greet = Task.make("example/greet", {
  version: 1,
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.Struct({ text: Schema.String }),
  error: Schema.Never,
  outputs: { greeting: Greeting },
  replay: "idempotent",
});

const GreetingTasks = TaskGroup.make(Greet);
const GreetingLive = GreetingTasks.toLayer({
  "example/greet": ({ name }) => Effect.succeed({ text: `Hello, ${name}` }),
});
```

Task return values and artifacts are different. This handler returns a result; it does not implicitly publish a greeting artifact. A handler that writes one uses a typed `TaskContext.publish(Greeting, value)` effect and receives an artifact reference. Publication errors must be in its declared error contract, or handled explicitly. Runtime/storage failures outside the handler appear in the run's infrastructure failure envelope.

## Public primitives

| Primitive | Specification | Implementation/composition |
| --- | --- | --- |
| `Task.make(id, options)` | Version, input/success/error schemas, named outputs, replay policy | `.toLayer(handler)`; handler receives decoded input and requires typed services |
| `TaskGroup.make(...tasks)` | Union of task contracts | `.add`, `.merge`, `.toLayer(handlers)`; every task implemented exactly once |
| `Artifact.make(id, options)` | Versioned content schema, content type, retention default | Typed lake publisher and reader |
| `Workflow.make(id, options)` | Version, payload/result/error schemas, graph builder | `.toLayer()` compiles graph to Effect workflow operations |
| `Extension.make(id, options)` | Version, contributions, declared replacement slots | Implementation Layers selected during activation |
| `Runtime.make(specs, options)` | Validated registry and policy selections | Effect yielding a scoped runtime; no hidden `runPromise` |

`Runtime.make` is effectful because acquiring a runtime can fail. Pure spec constructors must not perform I/O. Malformed dynamic specs are rejected by an effectful compile/validation phase with accumulated diagnostics.

A task represents a Swamp method. A group with a shared configuration schema represents a behavior type. A configured instance binds a stable instance ID and validated configuration to the group's handlers. Inputs, configuration and secret references stay distinct. Changing configuration creates a new revision; a run pins its instance revision.

## Workflow graph proposal

```ts
// Proposed declarative builder; implementations are supplied separately.
const Welcome = Workflow.make("example/welcome", {
  version: 1,
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.Struct({ text: Schema.String }),
  error: Schema.Never,
  build: (flow) => {
    const greeting = flow.task("greet", Greet, { name: flow.input.name });
    return flow.succeed(greeting.output);
  },
});
```

The builder executes during compilation and records a graph; it does not run Greet. `flow.input` and task outputs are typed expression references. Dependencies are inferred from those references, with explicit `dependsOn` for ordering without data flow. Stable step IDs are mandatory. Cycles, duplicate IDs, unknown tasks, schema mismatches and unbounded recursion fail validation.

Initial graph operations: task, sequence, parallel, bounded `forEach`, typed branch, approval, signal wait, durable delay, and result. Nesting uses a pinned workflow revision. Dynamic fan-out records the input collection and stable item keys before scheduling children. A branch records its selected path. `map` expressions use a serializable expression AST; arbitrary JavaScript callbacks are not portable graph values. A later named transform task can handle more complex mappings.

TaskGroup implementation inference should follow RpcGroup: a handler must return `Effect<Success.Type, Error.Type, R>`. The Layer retains `R`, including codec services where relevant. Unknown payloads at dynamic extension/RPC boundaries are decoded through the selected task schema. Never claim static TypeScript inference for a plugin discovered only at runtime. Generated clients or importing its spec package can provide that inference.

## Composition rules

Duplicate IDs are errors, including identical declarations from different extensions. A replacement names its target, expected contract version and scope explicitly. Types alone do not prove semantic schema compatibility; replacement implementations must satisfy the original spec and contract tests. A changed input/output contract gets a new version.

Use `Layer.provide` to satisfy a handler's dependencies and `Layer.mergeAll` for independent implementations. Do not merge two Layers providing the same core service and rely on merge order to choose a winner. Registry compilation selects one provider for each slot before building the Layer graph.

Initial public API checks must prove handler input inference, rejection of wrong success/error types, retained service requirements, graph reference types and schema round trips. Documentation examples become compiling fixtures only once the APIs exist.

# Five authoring APIs for review

> Decision update: graph workflows with Effect-based construction are now selected. `Task.make(spec, handler)` and `Workflow.make(spec, constructionEffect)` replace the earlier chained constructor sketches below. See the [current authoring API](authoring-runtime.md). Alternative syntax and undecided-status statements below describe the earlier exploration.

Status: five competing designs, not five modes we intend to ship. All Effectory APIs below are proposals; snippets are not compiled implementations. The review should favor the customer's experience over convenience for the engine author. The public workflow syntax is not decided. Named configured integrations are not assumed to be required.

Claude has completed an [independent DX review](authoring-api-review-claude.md). Its recommendation is Option 3 if pre-run inspection and structural graph patches are required; Option 1 is the alternative when runtime call interception suffices. No API has been selected. See the review follow-up at the end for qualifications.

## What the sources suggest

Effect supplies schema-described RPC contracts, typed handler Layers and durable Workflow/Activity execution. Our pinned sources are [RpcGroup](../vendor/effect/packages/effect/src/rpc/RpcGroup.ts) and [Workflow](../vendor/effect/packages/effect/src/workflow/Workflow.ts).

Swamp gives users behavior types, configured definitions, methods and workflows with named jobs/steps. Definitions and expressions form an inspectable execution structure. See its [architecture](../vendor/swamp/design/architecture.md).

Alchemy's current documentation uses Effect-based resource declarations. Yielding a resource inside a stack registers it and returns lazy outputs; provisioning happens later. This corrects our earlier two-way framing: a generator can construct a declarative graph instead of directly executing tasks. [Resources](https://alchemy.run/infrastructure-as-code/resource/)

Output references carry dependencies between nodes. Alchemy also supports lazy transformations; that does not mean every such transformation is a portable data AST. [Inputs and Outputs](https://alchemy.run/infrastructure-as-code/outputs/)

Alchemy supplies lifecycle implementations through provider Layers and separates resource declarations from reconciliation. Its custom-resource pattern is a useful analogue for extension-defined task contracts and providers. [Providers](https://alchemy.run/infrastructure-as-code/provider/)

Alchemy Actions are a closer match for tasks than managed Resources: they perform work during apply without a resource delete/replace lifecycle. Alchemy can skip an Action when its resolved input hash is unchanged. Effectory must not inherit that cross-run caching by default: fetching the same repository tomorrow is new work. [Actions](https://alchemy.run/infrastructure-as-code/action/)

Resource removal/replacement semantics should not become task cancellation or artifact deletion semantics. Durable workflow runs, external side effects, managed resources and lake retention need separate contracts. Alchemy's reconciliation and removal policies remain useful inspiration where we actually manage a resource. [Resource lifecycle](https://alchemy.run/infrastructure-as-code/resource-lifecycle/)

## Common example and contracts

Every option must express the same workflow: fetch a release, render a summary, publish the summary, return its URL. We deliberately make rendering a task for comparison; real users can keep trivial pure formatting as a transformation.

```ts
import { Application, Task, Workflow } from "@effectory/core";
import { Effect, Layer, Schema } from "effect";

const Input = Schema.Struct({ repository: Schema.String });
const Release = Schema.Struct({ version: Schema.String, notes: Schema.String });
const Summary = Schema.Struct({ markdown: Schema.String });
const Published = Schema.Struct({ url: Schema.String });
const Failure = Schema.Struct({
  _tag: Schema.Literal("ReleaseFailure"),
  message: Schema.String,
});

const FetchRelease = Task.make("releases/fetch", {
  version: 1,
  input: Input,
  success: Release,
  error: Failure,
  replay: "idempotent",
});
const RenderSummary = Task.make("releases/render", {
  version: 1,
  input: Release,
  success: Summary,
  error: Schema.Never,
  replay: "idempotent",
});
const PublishSummary = Task.make("releases/publish", {
  version: 1,
  input: Summary,
  success: Published,
  error: Failure,
  replay: "idempotent",
});

const ReleaseWorkflow = Workflow.make("release-summary", {
  version: 1,
  input: Input,
  success: Published,
  error: Failure,
});
```

A production PublishSummary handler must actually honor a stable idempotency key; the declaration alone cannot make publishing idempotent. The schemas here are service-free and serializable. Domain errors remain distinct from standardized execution failures, interruption and defects.

Task implementation stays Effect-native in all options:

```ts
const RenderSummaryLive = RenderSummary.implement(({ version, notes }) =>
  Effect.succeed({ markdown: `# ${version}\n\n${notes}` })
);
```

FetchReleaseLive and PublishSummaryLive below stand for equivalent implementations using application services. `.implement` pairs each spec with its handler Layer; `.toLayer` remains available as a lower-level API. Workflows refer to contracts, so selecting an extension's replacement implementation does not require rewriting the workflow source.

Every option yields a workflow definition called `ReleaseSummary`. Registration and standalone task exposure are deliberately the same for a fair comparison:

```ts
export default Application.make({
  tasks: [FetchReleaseLive, RenderSummaryLive, PublishSummaryLive],
  workflows: [ReleaseSummary],
}).provide(ReleaseServicesLive);
```

`ReleaseServicesLive` provides the integration clients required by those handlers; it is not a built-in. The runner loads this default export from `effectory.ts`. The generator alternatives do not silently change whether unregistered task implementations are auto-discovered.

All runs pin their application revision. Resuming a run can reuse its recorded step results; starting a new run does not reuse an earlier run's results unless a task explicitly opts into a future cross-run cache policy.

## Option 1 — Executable Effect program

```ts
const ReleaseSummary = ReleaseWorkflow.implement((input) =>
  Effect.gen(function* () {
    const release = yield* FetchRelease.call("fetch", input);
    const summary = yield* RenderSummary.call("render", release);
    return yield* PublishSummary.call("publish", summary);
  })
);
```

**What an author holds:** real decoded values. `yield*` calls or replays an operation during a run. The next line can inspect its result directly.

**Composition:** normal functions, Effect.gen, Effect.forEach, Effect.all and ordinary branching. Fan-out uses stable item keys and bounded concurrency. A child workflow call has its own nested invocation scope.

**Adding an approval:** yield a durable approval operation between render and publish. Denial is handled with ordinary control flow; durable timers and signals need their dedicated runtime operations, not ordinary in-memory sleeps/deferreds.

**Extension behavior:** replacing a task/provider is natural. Inserting a step into someone else's generator cannot be guaranteed by a general graph patch. Named invocation routing can change a reached call, but it cannot expose all future control flow before the program runs.

**Cost to the customer:** replay rules. Direct I/O, random values and wall-clock reads in orchestration can repeat or change a later branch. Only recorded calls are replay-safe. A complete workflow graph cannot be obtained by static inspection or by evaluating the generator with arbitrary fake values.

**Most likely mistake:** assuming any Effect yielded inside the workflow is automatically durable. The type system does not establish this.

## Option 2 — Alchemy-style declarative generator

```ts
const ReleaseSummary = ReleaseWorkflow.declare((input) =>
  Effect.gen(function* () {
    const release = yield* FetchRelease.step("fetch", input);
    const summary = yield* RenderSummary.step("render", release);
    const published = yield* PublishSummary.step("publish", summary);
    return published;
  })
);
```

**What an author holds:** typed `Output<T>` references. This generator runs while constructing the workflow; it does not fetch or publish anything. `.step` records a node and returns its output reference. The runner executes the collected graph later. `input` is a reference to the submitted payload, not that payload itself.

The `.step` name deliberately differs from Option 1's `.call`; identical syntax with different yield semantics would be misleading. Property access such as `release.version` produces another reference, not a string.

**Composition:** helpers return declaration Effects; yielding them collects their nodes in an explicit namespace. Output references establish dependency edges. Sequential declaration does not impose execution ordering between independent nodes. An explicit dependency option is required for ordering without data flow. Use dedicated branch/fan-out declarations for runtime-dependent choices. A normal JavaScript `if (release.version)` tests a reference object and is wrong.

**Adding an approval:** declare an approval node and connect its successful result as a dependency of publish. Its denied/expired behavior must be specified. Merely yielding it on the preceding line cannot enforce execution order.

**Extension behavior:** the constructed graph exposes stable nodes and edges for validation and versioned patches before execution. Extensions can replace tasks or add a gate without rewriting the source generator.

**Cost to the customer:** one syntax participates in two phases. Familiar Effect authoring does not imply familiar runtime values. Output transforms need an explicit supported vocabulary; arbitrary closures cannot be serialized as JSON. Allowing such transforms requires retaining executable bundles and clear replay rules. Initial design should restrict them to pure, deterministic operations.

**Most likely mistake:** treating an Output as its resolved value, or assuming yield order equals task execution order. Construction must not perform external I/O; this is a contract, not a sandbox enforceable by TypeScript alone.

## Option 3 — Explicit graph builder

```ts
const ReleaseSummary = ReleaseWorkflow.build((graph) => {
  const release = graph.task("fetch", FetchRelease, graph.input);
  const summary = graph.task("render", RenderSummary, release.output);
  const published = graph.task("publish", PublishSummary, summary.output);
  return graph.succeed(published.output);
});
```

**What an author holds:** node handles and typed output references. The plain callback constructs a graph. It cannot be mistaken for an Effect handler. `graph` is the callback variable, not an external framework or imported service.

**Composition:** small helper functions accept a graph scope and return handles. `graph.scope("name", ...)` namespaces reusable subgraphs. Explicit branch, fan-out, wait and dependency operations are available on the builder rather than spread across global modules. Only references establish data dependencies.

**Adding an approval:** a visible `graph.approval("review", ...)` node plus an explicit publish dependency. The builder can validate cycles and invalid edges.

**Extension behavior:** patches operate on the graph's node IDs, with schema checks before a new application revision becomes active.

**Cost to the customer:** learning the builder and its expression/reference types. The callback is still arbitrary JS during construction; restrict it to deterministic definition-building. Workflow runtime branching requires graph operations. Effect services remain in task implementations, not this callback.

**Most likely mistake:** using plain JavaScript with an unresolved reference, or forgetting an ordering dependency when two nodes do not exchange data.

## Option 4 — Named step specification object

```ts
import { Ref, Step } from "@effectory/core";

const ReleaseSummary = ReleaseWorkflow.steps({
  fetch: Step.task(FetchRelease, {
    repository: Ref.input("repository"),
  }),
  render: Step.task(RenderSummary, Ref.output("fetch")),
  publish: Step.task(PublishSummary, Ref.output("render")),
}).returns(Ref.output("publish"));
```

**What an author holds:** a specification object. Object keys supply invocation IDs, avoiding a separate string inside each declaration. `Ref` builds a reference AST; it does not evaluate a string expression or run a JavaScript function.

**Composition:** named subworkflow nodes and explicit step-spec fragments. Raw object spread must not silently overwrite a step: a merge helper rejects duplicate names. Branch, fan-out and approval are distinct Step variants. The normalized spec can be inspected, generated or transported as data with task version IDs. Actual handler functions and Effect Schema codecs remain in the code bundle.

**Adding an approval:** add a named approval entry and a publish dependency on its accepted outcome. Extensions can manipulate the same specification data.

**Extension behavior:** addressable steps and explicit references support patches, schema validation and agent-generated edits naturally.

**Cost to the customer:** named references are more indirect than local variables. Full inference across forward references and the containing object is a substantial API requirement, not something the example proves. `Ref.output("fetch")` must be contextually validated against the completed step map. A prototype must establish whether TypeScript can produce useful autocomplete and errors without casts, extra generic annotations or a typed step-token API. Do not accept `any` as the solution. Runtime validation is also required for loaded JSON.

**Most likely mistake:** a misspelled reference or a confusing error at the outer spec rather than at the offending property. This is the closest shape to Swamp's file-authored workflows, without adopting YAML or CEL as the primary API.

## Option 5 — Typed pipeline combinators

```ts
const ReleaseSummary = ReleaseWorkflow.pipeline(
  Step.run("fetch", FetchRelease),
  Step.run("render", RenderSummary),
  Step.run("publish", PublishSummary)
);
```

**What an author holds:** typed stage declarations. The workflow input feeds the first stage; each result feeds the next. The final result is the workflow output. Pipeline composition rejects incompatible adjacent input/output schemas/types. Schemas still validate encoded values at execution boundaries.

**Composition:** a pipeline is itself a reusable stage. Use a named `Step.parallel` combinator for branching work and explicit projection/map stages to reshape its result. Runtime conditional routing uses a branch combinator. All combinators compile to named graph nodes, with qualified IDs for nested stages.

For example, a branch that keeps two results would produce a record for its next stage (an additional hypothetical `FetchMetadata` task is used here):

```ts
Step.parallel(
  "inspect",
  {
    release: Step.run("release", FetchRelease),
    metadata: Step.run("metadata", FetchMetadata),
  },
  { concurrency: 2 }
);
// Result: { release: Release; metadata: Metadata }
```

**Adding an approval:** insert a `Step.approve("review", ...)` gate that preserves its input on approval and emits an explicit rejection/timeout outcome otherwise. It is naturally ordered because stage ordering is part of the contract.

**Extension behavior:** named stages provide stable patch targets; inserting a gate is straightforward. Changing an intermediate stage may break its neighbors and must fail schema validation before activation.

**Cost to the customer:** elegant while data flows linearly. Complex DAGs require carrying earlier values forward, nested named records or explicit reference combinators. If users constantly reshape data merely to retain an earlier result, this abstraction is working against them. Error messages must identify the failing stage boundary rather than report a huge inferred tuple type.

**Most likely mistake:** losing access to an earlier output or creating awkward pass-through objects just to join results later. This could be a convenience over a graph API instead of the only public workflow language.

## Questions every option must survive

Review these concrete changes, not just the three-line happy path:

1. Fetch releases for a runtime-supplied list of repositories, with concurrency 4 and stable keys across retries.
2. Branch on a fetched release's `prerelease` field (add it to the shared schema). Both branches must satisfy the workflow's declared success/error contract.
3. Insert a durable approval before publishing, including denial and timeout.
4. Reuse fetch-and-render inside two larger workflows without ID collisions.
5. Replace FetchRelease's implementation for tests, then for one deployment.
6. Let an extension insert an approval without editing the original workflow.
7. Resume after the publisher succeeded externally but before its result persisted. No syntax eliminates the need for idempotency or reconciliation.
8. Diagnose an input typo, a missing provider and an output-schema mismatch in the editor, then diagnose the equivalent failures in a dynamically loaded extension.
9. See what will run before starting, and see what actually ran afterward.
10. Run a task independently from the CLI without turning it into a managed resource with create/update/delete lifecycle hooks.

## Review request

Assess first-use clarity, autocomplete, type errors, ordinary TS/Effect skill transfer, composition, debugging, extension authoring and surprising execution semantics. Distinguish customers writing workflows from extension authors writing task providers. Rank the five qualitatively, choose a primary API if justified, and name concrete changes required before adopting it. Treat all inference claims as unproven until a type-level prototype exists. Do not favor an option just because it is easy to implement internally.

The proposed snippets intentionally hold contracts, provider binding, application loading and durability guarantees constant. If the reviewer thinks one of those shared choices hurts DX, that is also relevant feedback. No choice is preselected.

## Review follow-up

The independent review ranks the explicit builder first, executable Effect second, pipeline third as shorthand, the spec object fourth as an internal format, and the declarative generator fifth for workflow authors. This is qualitative design judgment, not measured usability or verified TypeScript inference.

Useful findings to carry into the next pass:

- A generator's named-call interceptor can insert an approval before a reached publish call. Structural graph rewriting and complete pre-run inspection are stronger requirements than that example alone establishes.
- Approval rejection and timeout need defined run-level outcomes if extensions add gates without changing a workflow's domain success/error contract.
- Task replacement in tests needs a customer API, not just an internal Layer trick.
- Structural TypeScript assignability does not establish Effect Schema codec compatibility. Execution boundaries still require validation.

Qualifications from the parent review:

- A queryable lake does not itself require a declarative workflow graph. Persisted artifacts and execution events are queryable with either execution model. Inspecting/editing a complete workflow definition is the separate requirement.
- A pinned code bundle does not make a function pure or prevent it from running again after a crash before its result commits. Recorded map/predicate nodes need stable identity, encoded-result schemas and a no-side-effects contract. Their closures can capture nondeterministic state too. Arbitrary closures are not portable just because the module containing them is pinned; a reproducible node reconstruction strategy remains necessary.
- Alchemy-style construction is a real option, even though Claude recommends against it here. Its reference-versus-value and declaration-order pitfalls also affect graph builders; prototype the actual diagnostics before rejecting it.
- Recommendations to reduce boilerplate or infer step IDs need compatibility and identity checks. They have not changed the public API proposals automatically.

The next useful evidence is a small type-level comparison of reference inputs, branch result types and editor errors, alongside the same realistic workflow in both shortlisted styles. The user has not yet selected a primary authoring API.

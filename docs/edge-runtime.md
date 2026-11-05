# Customer applications and the edge runner

> Decision update: graph workflows with Effect-based construction are now selected. `Task.make(spec, handler)` and `Workflow.make(spec, constructionEffect)` replace the earlier chained constructor sketches below. See the [current authoring API](authoring-runtime.md). Alternative syntax and undecided-status statements below describe the earlier exploration.

Status: proposed public API, not implemented. Here “edge runner” means the process that loads a customer's application and executes its work. It does not imply Cloudflare Workers, an isolate API or deployment to a particular vendor. The initial host is the Bun daemon described in [daemon and RPC](daemon-rpc.md).

## The customer contract

A customer exports one application from `effectory.ts`. It declares which tasks, workflows and extensions are available. The runner loads it, validates it, acquires the services it needs, and accepts runs through RPC. The customer does not write a scheduler, RPC server, registration loop or process entry point.

Use ordinary module imports. Avoid filename suffixes, recursive source scanning, decorators and side-effect registration. A task imported by an example or test must not accidentally become available in the runner. Imported code is not registered until the application includes it.

```text
my-automation/
  effectory.ts
  package.json
  tasks/
    fetch-release.ts
  workflows/
    release-summary.ts
```

This layout is an example, not a convention the runner interprets. A one-file application is equally valid; the [root README](../README.md) shows one in full.

## Pair specs with their implementations

The earlier `.toLayer(handler)` surface works well for service composition, but a consumer would otherwise have to maintain both a catalog of specs and a matching collection of Layers. Add a convenience method:

```ts
export const FetchRelease = Task.make("releases/fetch", {
  version: 1,
  input: ReleaseInput,
  success: Release,
  error: ReleaseError,
  replay: "idempotent",
}).implement(fetchRelease);
```

`ReleaseInput`, `Release`, `ReleaseError` and `fetchRelease` here are the author's schemas and handler. This is an abbreviated example. `.implement` is pure: it returns an immutable definition pairing a spec with its handler Layer. It does not execute the handler, connect a client or register a global service.

The returned definition preserves the spec's ID, version and schema accessors. In the Effect-program candidate it also preserves `.call(key, input)`. It exposes `.spec` and `.layer` for advanced composition. A call always resolves the selected implementation in the current application revision; it never bypasses an override by calling the function captured in the imported definition directly.

A customer can still separate contract and implementation:

```ts
// contracts.ts
export const FetchRelease = Task.make("releases/fetch", {
  version: 1,
  input: ReleaseInput,
  success: Release,
  error: ReleaseError,
  replay: "idempotent",
});

// tasks/fetch-release.ts
export const FetchReleaseLive = FetchRelease.implement(fetchRelease);
```

The application includes `FetchReleaseLive`. Workflows may import the pure `FetchRelease` contract. `.toLayer(handler)` remains useful when embedding or building custom runtimes, but ordinary runner registration uses the paired definition so the runner does not try to introspect an opaque Layer.

Workflow implementation follows the same shape, using the current generator candidate for illustration:

```ts
export const ReleaseSummary = Workflow.make("releases/summary", {
  version: 1,
  input: FetchRelease.inputSchema,
  success: Summary,
  error: FetchRelease.errorSchema,
}).implement((input) =>
  Effect.gen(function* () {
    const release = yield* FetchRelease.call("fetch", input);
    return { text: `Release ${release.version}` };
  })
);
```

This assumes `Summary` describes `{ text: string }`. Formatting does not need to be a separate task unless it needs an independent contract or execution record. The workflow syntax is still under review. A graph-backed workflow definition will carry its validated graph and interpreter Layer instead of this handler; the application's registration and runner lifecycle stay the same.

## Application.make

The recommended minimal entry point is:

```ts
import { Application } from "@effectory/core";

import { FetchRelease } from "./tasks/fetch-release";
import { ReleaseSummary } from "./workflows/release-summary";

export default Application.make({
  tasks: [FetchRelease],
  workflows: [ReleaseSummary],
});
```

Public surface proposed for this pass:

| API | Customer-facing contract |
| --- | --- |
| `TaskSpec.implement(handler)` | Pair a task spec with a typed handler; preserve unresolved service requirements |
| `WorkflowSpec.implement(handler)` | Pair a workflow spec with its Effect implementation in the generator candidate |
| `TaskDefinition.provide(layer)` | Supply task-local services without changing its contract or identity |
| `WorkflowDefinition.provide(layer)` | Supply workflow-local services; replay-safety rules still apply |
| `Application.make({ tasks?, workflows?, extensions? })` | Define the exposed application; omitted collections are empty |
| `Application.provide(layer)` | Supply shared application services; return a new application definition |
| `Application.layer` | Build the validated application into an AuthoringRuntime service for embedding |

`Application.make` is pure. Missing bindings, duplicate IDs, incompatible versions and dynamic extension conflicts are startup validation errors with paths back to the declarations. Missing service requirements remain visible in TypeScript for statically composed definitions; the CLI must also check them when loading JS or TS without a typecheck. `.provide` accumulates explicit service providers; duplicate providers are rejected unless a separate replacement selection was declared. It is not a last-write-wins override API.

Conceptually `TaskDefinition<Id, Version, I, O, E, R>` contains spec metadata and a handler Layer requiring `R`; `Application<R>` retains external requirements not satisfied by `.provide`. These are design types, not current exported declarations. Runtime operations still return typed failures for invalid manifests and dynamic bindings that TypeScript cannot prove.

The runner supplies engine, task/workflow execution contexts, run storage, lake, secrets interface and platform services. A customer supplies application-specific services. Those are different sets of requirements: user code must not have to provide a WorkflowEngine simply to declare a task.

### Service dependencies without per-workflow wiring

```ts
export default Application.make({
  tasks: [FetchRelease],
  workflows: [ReleaseSummary],
}).provide(GitHubClientLive);
```

`GitHubClientLive` is an ordinary Effect Layer whose configuration may use secret references. Acquire it once per application revision and release it after that revision's active runs drain. Task-specific providers take scope only within that definition; they cannot replace shared persistence or the runner's host services. Use explicit task-level provision for two integration implementations requiring different clients. Named configured behavior instances remain a separate API gap.

Application composition automatically links registered task-handler requirements to the selected task definitions. Authors should not need to manually nest `Layer.provide` between every task and workflow. The runner uses declared handler identities and the registration catalog, not guesses based on Layer merge order. Arbitrary custom service Layers must still have their own dependencies composed or supplied explicitly; we do not promise general dependency discovery from JavaScript functions.

### What is registered

Every task in `tasks` can run independently and be called by workflows. Every workflow in `workflows` can be submitted by name. A workflow's imported task is not automatically registered. Explicit inclusion makes the available surface reviewable and allows contracts to be bound to different implementations.

For larger applications, `TaskGroup.implement(handlers)` can produce a group of paired task definitions and `WorkflowGroup.implement(handlers)` the corresponding workflow group. Application collections accept individual definitions or these explicit groups and flatten them once. Repeated `(kind, ID, version)` identities are errors, even if the same object was included twice. A bare, unimplemented spec in either collection is an error. If multiple versions of an ID are exposed, the CLI requires `id@version`; an unversioned name is accepted only when it resolves unambiguously. Workflow references always retain an explicit contract version.

Graph workflows declare their complete handler requirements during validation. Arbitrary generator code cannot promise that: static typing catches known requirements, but dynamic/conditional calls may still fail with a precise MissingTask error when reached. The runner must not claim that importing a generator discovered its whole graph. It must never download a missing task implicitly.

## How the runner picks up the application

The default discovery rule searches from the CLI's current directory upward for `effectory.ts`, stopping at the nearest Git root (or filesystem root outside Git). The nearest file wins. `--entry <path>` selects an explicit alternative and takes precedence. The CLI reports the resolved application path in status/errors. Multiple applications in a monorepo can each have an entry point.

Only the runner evaluates the entry module. A CLI invocation connects to that application's runner; it does not independently import customer code on every command. Importing a module can execute top-level JavaScript, so application source is trusted code and discovery is not a sandbox. The authoring contract requires declarations at module scope and I/O inside handlers or scoped Layers.

Startup has a visible sequence:

1. Resolve the entry point and restore the exact extension/dependency inputs.
2. Compile its reachable module graph into an immutable application bundle; evaluate the default export and require an Application definition.
3. Validate boundaries, implementations, selected overrides and supported host capabilities. Acquire the application Layer and check required services.
4. Register the catalog under a revision containing bundle and lockfile digests.
5. Advertise readiness and expose discovery/schema RPCs. Work is now admissible.

A partially loaded application never accepts a run. Errors identify the entry, task/workflow and failing phase. A missing default export says what to export; a missing provider names the unsatisfied service. Layer acquisition failure cleans up resources already acquired.

## Development and normal operation

```sh
# Start a local runner and rebuild on source changes.
effectory dev

# Start the same application without watching source files.
effectory daemon start

# Choose another entry point explicitly.
effectory daemon start --entry ./automation/effectory.ts

# Discover what the running application exposes.
effectory task list --json
effectory workflow list --json

# Submit and optionally detach from observation.
effectory workflow run releases/summary \
  --input '{"repository":"owner/repo"}' --background
```

`dev` stages, validates and activates each new revision atomically. Syntax or provider errors leave the last good revision running and report the failed update. Existing runs use their pinned revision, including across suspension and restart. Stopping `dev` stops that runner; durable accepted work remains available when it is restarted. Merely disconnecting a CLI watcher does not stop it.

Normal daemon startup loads once; source edits have no effect until an explicit restart/reload. Customers do not increment a schema version for every code edit: contract versions describe boundary compatibility, while the application revision pins exact code and dependency resolution. Old bundles and their dependency closure must remain available while runs can resume.

The initial runner should execute distinct application revisions in isolated worker processes. Re-importing a changed file into one shared module cache is not a sufficient revision-isolation strategy. The parent runner retains the exclusive repository lease and owns durable storage; workers use its scoped execution services instead of opening competing writable runtime stores. Service Layers and credentials are acquired for the revision; secret values are resolved at execution, not frozen inside the bundle. External service behavior is not reproducible just because customer code is pinned.

## From submission to invocation

The CLI sends the workflow/task name, input and request key over RPC. The runner resolves the active revision, validates the input and commits a run before replying with its ID. It schedules the selected implementation in a run scope. A task call resolves `(task ID, contract version)` from that pinned revision and records the invocation key and input before execution. The task receives its scoped services and TaskContext; its encoded outcome becomes available to the workflow and run observers. See [execution](execution.md) for replay and crash guarantees.

A task submitted directly uses the same machinery as a task called by a workflow. No API handler keeps a background run alive; the runner owns it. `.call` creates a workflow invocation, while CLI submission creates a root run. These are distinct identities even when they target the same task contract.

## Extensions and other execution targets

An installed extension contributes the same paired definitions and provider choices as local code. The application references an explicit extension export in `extensions`; the host resolves it from the verified locked bundle. Detailed GitHub specifier/export syntax remains part of the extension API pass. A customer should not write a different task API for downloaded code.

A future remote runner should load the same immutable application artifact, not search the customer's laptop for source files. A deployment artifact needs entry metadata, code and dependency digests, schema/catalog metadata, platform targets and the extension lock. Deploy/worker enrollment commands are not defined yet.

Different hosts supply different platform Layers. A task needing child processes cannot silently work on a host without them; startup checks declared capabilities and typed provider requirements. Arbitrary in-process JS can bypass those service interfaces, so this is compatibility validation, not security enforcement. No claim of browser/serverless isolate support follows from this local runner design.

## Acceptance criteria for the consumer experience

- The one-file README example can be loaded without writing runner infrastructure.
- Moving a task file changes only its import; its public ID stays the same.
- An unregistered imported task does not appear in task discovery.
- Incorrect default exports, duplicate IDs and missing providers fail clearly.
- A CLI process never evaluates the entry module while submitting or watching.
- Failed development reload keeps the last valid application serving new runs.
- A suspended run resumes with its original implementation after source changes.
- Standalone tasks and workflow calls expose the same schemas and error behavior.
- Both prospective workflow authoring models fit the same Application contract.

These are implementation acceptance tests to write later. This documentation pass does not implement the APIs, commands, bundler or runner.

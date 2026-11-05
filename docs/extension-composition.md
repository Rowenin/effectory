# Extension composition and workflow patches

Status: planning pass 3 of 5. These are proposals, not accepted or implemented exports. Examples are not typechecked. Preserve the selected spec-first [authoring model](authoring-runtime.md), [graph semantics](graph-composition.md) and [task handler contract](task-implementation.md).

## Recommendation

An extension declares contributions. The host chooses which installed extension participates in an application and explicitly selects replacements and patches. Installation, application inclusion and override selection are separate actions. Load order never chooses a winner.

| Proposed API | Purpose |
| --- | --- |
| `Extension.make(spec)` | Package tasks, workflows, artifacts, implementations and patches |
| Generated `ReleaseTools.tasks.InspectRelease` | Typed task contract for `graph.task` in local workflows |
| `Extension.use(exportsOrId, selection?)` | Select an installed extension in an application |
| `Task.implementation(spec, handler)` | Offer a replacement implementation of an existing contract |
| `WorkflowPatch.make(spec, build)` | Declare an additive subgraph before a compatible task invocation |

`Extension.make` is pure metadata assembly. Existing `Task.make(spec, handler)` and `Workflow.make(spec, constructionEffect)` remain unchanged. These additions replace the older exploratory `ExtensionSpec.toLayer(...)` registration shape; ordinary Effect Layers still provide handler dependencies.

## An extension author

Suppose a shared contract package exports `FetchRelease` and `PublishSummary`, and `CachedReleases` is an application service whose `fetch` satisfies the original FetchRelease input/success/error contract and replay obligations.

```ts
import { Extension, Task, Workflow, WorkflowPatch } from "@effectory/core";
import { FetchRelease, PublishSummary } from "@example/release-contracts";
import { Effect } from "effect";

import { CachedReleases } from "./cached-releases";
import { InspectRelease } from "./tasks";

const CachedFetch = Task.implementation(
  { id: "acme/release-tools/cached-fetch", target: FetchRelease },
  (input, context) =>
    Effect.gen(function* () {
      const releases = yield* CachedReleases;
      return yield* releases.fetch(input, { key: context.key("fetch") });
    })
);

const ReviewPublish = WorkflowPatch.make(
  { id: "acme/release-tools/review-publish", target: PublishSummary },
  (input) =>
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      yield* graph.approval("review", {
        prompt: "Approve publishing this release?",
        context: input,
        timeout: "24 hours",
      });
    })
);

export default Extension.make({
  id: "acme/release-tools",
  version: "1.0.0",
  tasks: { InspectRelease },
  implementations: [CachedFetch],
  patches: [ReviewPublish],
});
```

Imports are hypothetical definitions. Task and patch contributions have stable, namespaced IDs. Named task records establish public exports; workflows and artifacts may use named records too. See the [typed consumption proposal](extension-task-consumption.md) for the proposed refinement from task arrays, generated imports and contract types. Service requirements from all selected executable contributions remain visible where statically known and must be satisfied by Layers before activation.

`Task.implementation` receives the original contract and infers `(input, context)` from it. It cannot supply replacement schemas, output declarations or replay policy. Its own ID identifies the provider, while run task identity remains FetchRelease's. A provider needing a different contract declares a different task instead.

The patch callback receives a reference to the target invocation's resolved input, not its runtime value. The target contract supplies its type. It returns an Effect that constructs a scoped subgraph and yields no public result. This callback is a proposed patch-specific boundary; it does not change Workflow's Effect-valued second argument. Input typing and retained service requirements still need a prototype.

## Using contributed tasks

Install with a local binding name, then import and pass the typed task to the ordinary graph builder:

```ts
import { ReleaseTools } from "./effectory.extensions";

// Inside a local workflow's construction Effect:
const release =
  yield *
  graph.task("inspect", ReleaseTools.tasks.InspectRelease, {
    repository: "swamp-club/swamp",
  });
```

The application selects `Extension.use(ReleaseTools)` once. The contract import provides types and codecs; selection provides the registered implementation. See [the full install, workflow and application example](extension-task-consumption.md) for how generated bindings, service Layers and locked updates work.

## A host application

Install a locked package with a typed source binding, then select it:

```sh
effectory extension add github:acme/effectory-release-tools@v1.0.0 --as ReleaseTools
```

```ts
import { Application, Extension } from "@effectory/core";
import { FetchRelease, PublishSummary } from "@example/release-contracts";

import { ReleaseTools } from "./effectory.extensions";
import { ReleaseServicesLive } from "./services";
import { ReleaseSummary } from "./workflows";

export default Application.make({
  tasks: [FetchRelease, PublishSummary],
  workflows: [ReleaseSummary],
  extensions: [
    Extension.use(ReleaseTools, {
      implementations: ["acme/release-tools/cached-fetch"],
      patches: [
        {
          id: "release-review",
          use: "acme/release-tools/review-publish",
          workflow: { id: "release-summary", version: 1 },
          at: ["publish"],
        },
      ],
    }),
  ],
}).provide(ReleaseServicesLive);
```

`Extension.use` is a declarative installed-package selection. The typed descriptor comes from the generated local import; a string ID remains the dynamic form. The runner resolves implementations from the lockfile and immutable bundle cache. A missing package fails validation with an installation/restore instruction. Importing application source never fetches it from GitHub.

Including an extension registers its ordinary task/workflow/artifact contributions. It does not select any implementation or patch unless named in the selection. Here the host selects one replacement and binds one patch to the `publish` node of workflow contract version 1. The plan reports those exact choices and digests. The services Layer in the example must provide all selected service requirements, including the cached client; it cannot be inferred from opaque plugin code.

## Installation and activation correction

**Proposed clarification to the earlier extension lifecycle:** `ExtensionAdd` installs/verifies the archive, updates the installed inventory and lockfile, and returns its operation receipt. It does not implicitly include that package in the Application or select privileged replacements.

If the application does not reference it, the installed-registry revision changes but the active application revision does not. If it is already referenced, the host compiles a candidate application using the explicit selection, verifies all contributions, then activates a new application revision atomically. Startup with an unresolved required extension cannot advertise a ready application.

An update of a selected package follows the same candidate/activation transaction; failure preserves the prior active application and selection. A remove that would leave a required selection unresolved is refused until the application stops using it. Removing an unselected inventory entry still cannot collect bundles retained by old/recoverable runs. Distinguish installed-registry revision, active application revision and immutable package digest in operation results and SystemStatus.

For a selected update, validate the candidate before committing changed inventory and lock state. The [activation recovery contract](durability-and-recovery.md#revision-activation-and-restart) defines reconciliation across filesystem/database commits and concurrent reloads.

`expectedRevision` on the existing extension RPCs refers to the installed registry. Serialize candidate activation with application reload and compare the application revision used to build it as well; a stale candidate must never overwrite newer source or selections. `ExtensionAdd` needs no new override-selection flags or RPC. The source Application remains the authority for selection in v0.

## Contract compatibility and provider selection

Resolve replacement targets to canonical host contracts by task ID and contract version. The manifest also identifies the required shared contract package/digest. At execution, the host always uses the canonical input/success/error/output codecs, not schemas supplied by the replacement. Manifest, executable declaration and locked contract dependency must agree before activation.

Equal JSON Schema or assignable TypeScript types do not prove codec equivalence. Transforms and refinements make inferred schema compatibility unsafe. V0 requires the exact locked contract dependency; reject an independently redefined contract instead of attempting general schema equivalence. The build/distribution prototype must prove shared contract resolution without duplicate Effect/service identities. Static checking helps authors; dynamic providers still undergo runtime validation.

Exactly one selected implementation may replace a task identity application-wide. Selecting two produces an error naming both providers and the target. Array order, package install order and semantic version precedence never break the tie. New runs pin the selected provider digest; existing runs never switch implementations. Per-workflow/per-invocation replacement is deferred to keep selection inspectable.

Application-specific provider changes use ordinary explicit Layer provision. Infrastructure-provider extension contributions, such as Executor or SecretStore, need versioned host-slot contracts, explicit selection and contract tests before support. V0 does not expose generic Layer replacement for RunStore, authorization, workflow transitions or storage. Stateful provider changes require migration/drain, not a patch. This narrows the earlier broad override table to a buildable first cut.

## How a before-step patch works

The compiler attaches a patch to one exact task invocation with the expected target contract. It exposes only that target's input reference to the patch builder. The patch can add tasks, transformations and waits using the normal graph builder. It cannot alter the target input/result, remove existing dependencies, inspect arbitrary parent references or mutate the surrounding graph.

The compiler, not the extension author, creates the ordering barrier:

1. Original target input dependencies and `after` dependencies must succeed.
2. Capture/validate the target input once and activate its selected patch subgraphs.
3. Require every activated patch node to finish successfully.
4. Dispatch the original target with that same captured input.

The original target cannot remain runnable through an earlier dependency edge; its eligibility now includes the patch-completion barrier. Rejecting/expiring the review follows standard control outcomes, so publish never starts. The approval context is the exact captured input that publish later receives. This does not protect other publish invocations unless they are also targeted, and trusted task code remains capable of side effects outside its declared intent.

Patch bindings and inserted nodes receive stable identities derived from workflow, qualified target path, binding ID and local node ID. A reused local `review` name in different bindings does not collide. Patch IDs and node IDs cannot depend on load order. Patches cannot target nodes introduced by another patch in v0.

## Composition, scopes and conflicts

Two additive patches on the same target both run; the target waits for both. They are unordered by default. For example, a review gate and a validation task may proceed concurrently once input is ready. If review must happen first, the second host binding declares `after: ["release-review"]`. These references name host binding IDs on the same target. Missing dependencies, duplicate binding IDs and ordering cycles are activation errors. No implicit numeric priority exists.

Two replacements of the same task are a conflict. Two patches with duplicate local IDs inside one binding are a conflict. A missing/renamed target, mismatched workflow version or changed task contract is an error, not a skipped optional patch. Host bindings deliberately make workflow node IDs part of the extension-facing contract. A new graph revision with the same version is still checked structurally.

Root paths use `at: ["publish"]`. Nested template paths use explicit scope segments, for example `["mode", { branch: "onFalse" }, "publish"]` or `["targets", { item: true }, "publish"]`; their Effect Schema union must reject ambiguous paths. A patch within an unselected branch never opens. An item-template patch expands once per captured fan-out key, with distinct invocation/wait identities. There are no glob selectors or selectors for a particular runtime item key in v0.

A child workflow has its own definition. Patch that workflow's definition explicitly; do not traverse a parent `graph.workflow` call into its callee. Definition-level patches affect all uses of that child in the selected application revision. Call-site-only child customization is deferred. Patches may add registered linked workflows, but cannot create recursive definition cycles or escape their scope.

## Manifest, trust and reproducibility

The JSON manifest describes package identity/version, SDK/Effect compatibility, entrypoint, exported contribution IDs/kinds, required contracts/dependencies and requested capabilities. It is a schema-validated inventory, not executable graph or codec serialization. The loaded `Extension.make` export must match it exactly. Static inspection occurs before importing code; only trusted bundles are evaluated.

The lock records GitHub resolution, archive/manifest digests and dependency closure. The application revision additionally pins source bundle, non-secret configuration, contract identities, extension digests, provider selection, patch bindings and final graph identity. Old bundles remain available while runs or recovery reference them. After restart, resume the pinned effective graph; never reapply today's patch set.

In-process code and Layers remain privileged. Capability declarations are policy metadata, not a sandbox. A patch barrier guarantees scheduler ordering, not that arbitrary extension code cannot misbehave. The [distribution/trust design](extensions.md) continues to govern archive verification, `gh` use and immutable bundle retention.

## Minimum scope and proof

V0 includes contributed tasks/workflows/artifacts, explicit installed-package use, application-wide task replacement and additive before-step patches. Defer general graph rewrites, output-transforming/after/around middleware, runtime patching, per-call replacement, infrastructure-provider slots and named configured instances.

Required proofs: useful callback typing; canonical codec/service identity across bundles; manifest/export disagreement; explicit-selection-only activation; competing replacements; missing/version-mismatched targets; patch cycles; gate barrier correctness; scoped branch/fan-out identities; restart with an old patch revision; update/reload races; and removal with retained runs. No runtime behavior has been implemented or tested by this pass.

The main tradeoffs are application-owned selection versus install-time defaults, strict shared-contract identity versus permissive compatibility, and constrained before-step patches versus arbitrary graph editing. The greatest risk is letting an apparently harmless patch or provider update alter an already accepted run's meaning; immutable effective application revisions must prevent that.

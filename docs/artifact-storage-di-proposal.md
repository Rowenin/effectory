# ArtifactStorage through Effect DI — proposal for focused review

Status: **DI contract approved; JSON implementation available**. After presentation, the user replied “lgtm”. The selected lifetime permits publication during task-local Layer acquisition and the handler, with closure before Layer finalizers. The implemented JSON surface is documented in [ArtifactStorage](artifact-storage.md). Bytes signatures and binary product decisions below remain proposals. The remaining text records the review discussion and alternatives; it is not a second implementation contract.

The rest of [the binary-artifact proposal](binary-artifacts-api-draft.md)—byte limits, storage/retention decision, transport, integrity and cleanup—remains unapproved. This delta does not treat the user's DI correction as approval of those product decisions. No production edits are authorized by this review brief.

## Public decisions for discussion

Both Claude reviews requested small corrections before presentation. Those corrections are reconciled below, including presenting both reviewed lifetime choices. The reviews retain their original verdicts; the lead has applied their requested changes without another review round. Neither review replaces user approval. Probes used stand-ins, not an implemented SDK API.

1. Use `storage.publish(Definition, valueOrSource, { key, output?, tags? })`, with the artifact definition determining value and reference types.
2. Check membership in the current task's declared outputs at runtime. This loses the compile-time output-key filtering of `context.publish`, while retaining artifact/value type checking.
3. Require `output` only when the same artifact instance has several declared aliases. The alternative is rejecting such declarations at `Task.make`, which would remove the option but reject currently legal definitions. Keep aliases in this proposal.
4. Choose the publication lifetime: the conservative handler-only window, or acquisition plus handler with closure before task-local Layer release. Both reviewed models reject Layer-finalizer publications. Both are described below; neither is selected by the user's DI direction alone.
5. Retain JSON `context.publish` as a **legacy, not deprecated** adapter. New examples use the service.
6. An inner `Task.provide` replacement controls storage in production and in `Task.test`; it replaces the harness recorder too. Recommend the default `Task.test` service for task tests.

Supervisor placement, the commit fence, memo-map isolation and shared module loading are implementation details supporting those decisions.

## Recommended authoring shape (PROPOSED)

```ts
import { Artifact, ArtifactStorage, Task } from "@offtree/effectory-sdk";
import { Effect, Schema, Stream } from "effect";

const Csv = Artifact.make({
  id: "report/csv",
  version: 1,
  kind: "bytes",
  contentType: "text/csv",
});

const Export = Task.make(
  {
    id: "export",
    version: 1,
    input: Schema.Null,
    success: Csv.refSchema,
    error: Schema.Never,
    replay: "idempotent",
    outputs: { csv: Csv },
  },
  () =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      return yield* storage.publish(
        Csv,
        Stream.make("name\nAda\n").pipe(Stream.encodeText),
        { key: "report" }
      );
    })
);
```

Pass the artifact definition itself rather than an untyped output-name string. That lets the service infer the JSON value codec, bytes input, and schema-specific reference independently of which task calls it. JSON uses the same `storage.publish(JsonArtifact, decodedValue, options)` shape. No `ArtifactStorage.forTask`, generic ambient service, per-task tag factory, or duplicate constructor family.

The method takes these options (proposed; not implemented):

```ts
type PublishOptions = {
  readonly key: string;
  readonly output?: string;
  readonly tags?: Tag.Input;
};
```

`Tag.Input` is the existing typed-binding-array/raw-map input, imported from the SDK's Tag namespace. `tags` retains the existing publication-tag validation and precedence over inherited run tags. Reads stay on the lake API and CLI in this slice. There is no static `ArtifactStorage.publish` accessor.

`ArtifactStorage` is a required `Context.Service` with the stable key `@offtree/effectory-sdk/ArtifactStorage` and no default. Export the class directly from the SDK root, plus a `/ArtifactStorage` module. Use one conditional generic `publish` signature rather than overloads: the Effect review's probe found that overload diagnostics blamed missing bytes-artifact properties for a wrong JSON field. The conditional signature reports the actual value error and retains inference:

```ts
type Input<A, E, R> = A extends Artifact.Bytes
  ? Uint8Array | Stream.Stream<Uint8Array, E, R>
  : A extends Artifact.Artifact
    ? A["schema"]["Type"]
    : never;

type Publish = <
  A extends Artifact.Artifact | Artifact.Bytes,
  E = never,
  R = never,
>(
  artifact: A,
  value: Input<NoInfer<A>, E, R>,
  options: PublishOptions
) => Effect.Effect<A["refSchema"]["Type"], E | TaskRuntimeError, R>;
```

These are illustrative proposed type aliases, not additional promised exports. JSON inference comes only from the artifact argument. A Uint8Array introduces no unknown requirements/errors. Stream errors and R stay inferred, including an explicit source Scope. Runtime errors remain TaskRuntimeError. Reads, query, deletion and filesystem services are not silently added to this service in this slice.

A reusable Effect that yields the service has an ArtifactStorage requirement. Task.make/implementation and both provide signatures remove only the runner-owned requirements (`Tag.Values | ArtifactStorage`) from exposed R, including Layer inputs. Preserve every other dependency. Outside a task, use normal Layer.succeed/provideService to supply a test implementation; no implicit global storage or fallback run identity.

## Declared outputs and the unavoidable typing distinction

Keep `outputs: { csv: Csv }` for discovery, extension canonicality, named provenance and durable publication identity. A globally named Context.Service cannot know the current task's output-name type. Do not promise compile-time rejection of an artifact omitted from a particular task's outputs. The artifact/value/reference pairing remains static; membership is checked at the runner boundary **before pulling a source or writing content**.

The default runner service captures the task's output table and invocation identity. Resolve the supplied artifact by canonical object identity:

- No matching output: fail UnknownOutput, naming the artifact and task.
- Exactly one matching output: use that output name automatically; the common call needs only artifact, value/source, and key.
- The same artifact is declared under several output aliases: require optional `output` in publication options, e.g. `{ key: "report", output: "stdout" }`. Without it, fail InvalidBoundary and list the available aliases.
- If output is supplied, require that alias to point to that exact artifact; reject a wrong alias or a structurally equal foreign definition. Do not introduce a registry lookup by id that accepts schema drift.

If an id matches but the object does not, the UnknownOutput message must explain that an artifact with that id is declared by a different definition instance. This is a deterministic programming error, not a transient storage failure.

The optional alias preserves existing legal output maps instead of rejecting them or arbitrarily choosing the first name. It is a new exact signature choice for review, not user-approved syntax. Review whether another small call shape is materially clearer without creating a new capability DSL. Neither types nor checks should make source pulls happen at construction time.

Runtime identity remains principal/task/output/key across runs, and run/invocation/output/key for publication dedup. The service supplies identity, admitted run tags and host functions; callers pass none of those fields. Explicit publication tags keep the reviewed precedence. A separately overridden Tag.Values service changes typed reads, not the admitted raw labels inherited by the default storage service.

## Provisioning and lifetime: decisions needing careful review

Follow the successful Tag.Values placement: install the invocation-specific ArtifactStorage around the raw execution and all task-local Layer construction, inside Application's captured services. Use the existing fresh Layer memo map. A task-local helper Layer may yield and capture ArtifactStorage for methods called by the handler. An application/revision Layer cannot capture invocation storage; it must leave the service requirement on its operations or use a task-local Layer.

A Layer that yields ArtifactStorage belongs on `Task.provide`. Export applications with `satisfies Application.Application<never>` so a revision-level Layer that requires invocation storage cannot leave that requirement unnoticed. Runner storage overrides an application-level replacement; an explicit inner task replacement takes precedence over runner storage.

Distinguish direct service lookup from closure capture: a helper built at application scope can capture an explicitly supplied application-level fake in its methods. The runner cannot rewrite that closure, so those methods bypass production persistence for every run even though direct invocation lookups see runner storage. The `Application<never>` check detects unsatisfied requirements, not deliberate satisfaction with such a fake.

Build the default service in `definition.execute` from the low-level RuntimeContext hooks, the admitted tag snapshot, the task's output table and the invocation's admission cell. Both the host and Task.test already supply RuntimeContext; the new service and legacy adapter route to those same hooks, preserving the harness recorder.

**Proposed phase rule:** the service is available during task-local Layer acquisition, but actual publication is allowed only during the handler execution phase. Calling publish before the raw handler starts or after its closing barrier begins fails InvalidBoundary before source consumption. A Layer can construct a helper using storage; it should not publish task outputs while acquiring or finalizing resources. This preserves the verified supervisor placement inside all `.provide` wrappers, so publication children finish before source Layers release. It also avoids needing a supervisor to outlive failed Layer acquisition. The user has not approved this phase restriction: review it explicitly for consumer surprise, and propose a simpler complete ownership model if possible. Do not silently assume that service availability means publishing during Layer acquisition is safe.

Admission depends on **when the publication Effect runs**, not which fiber calls it. A fiber forked by a helper Layer may publish while the handler is active; its publication is supervised by that invocation. After closure the same fiber receives the closed-invocation error. Use distinct `InvalidBoundary` messages: "Publication is not available during task Layer acquisition; publish from the handler" and "Invocation closed". Acquisition-time failures remain typed TaskRuntimeError failures through `taskLayer`.

To publish buffered logs during cleanup, attach cleanup inside the handler, before the closing barrier, rather than to a task-local Layer finalizer. Proposed usage, assuming `handler`, `Log` and `buffered` have been defined:

```ts
Effect.gen(function* () {
  const storage = yield* ArtifactStorage;
  return yield* handler.pipe(
    Effect.onExit(() => storage.publish(Log, buffered, { key: "log" }))
  );
});
```

The same placement applies to `Effect.ensuring` or a scoped region closed inside the handler. Publication remains subject to cancellation and the host commit fence; this is not a guarantee that failure logs can always commit.

**Reviewed alternative — acquisition plus handler:** open admission when the service is installed. Close it before the first task-local Layer releases, interrupting and awaiting outstanding publications. The Effect reviewer modelled attaching an idempotent close barrier through the private `taskLayer` wrapper after each successful Layer acquisition, with an outer fallback for tasks without Layers. Its probes covered successful acquisition, failure of a later Layer, and preservation of Layer memo sharing. This permits a helper Layer to publish during setup; Layer finalizers still receive `InvalidBoundary: Invocation closed`. An acquisition-time commit remains durable if a later Layer or the handler fails, and retries use the same publication receipt identity.

The consumer reviewer preferred the handler-only rule; the Effect reviewer preferred acquisition plus handler. Present both, rather than claim that either is the only sound ownership model. The latter better aligns service availability with usability but needs implementation proofs for partial failure within a single composite Layer, parallel acquisition, and the ordering of all source finalizers; the existing model probes do not establish those cases. No code implementing either placement exists yet.

**Scope boundary in either model:** the release guarantee covers Layers attached through `Task.provide`. A manually nested `Effect.provide` or `Effect.scoped` inside a handler may release its resources earlier. Await publication inside that resource scope, or make the stream own its resources with ordinary scoped Stream operators. Do not detach a publication that uses resources from an earlier-closing inner scope and assume the invocation supervisor extends their lifetime.

The SDK owns the supervisor/admission phase at the placement selected above; the host owns the commit fence in the runtime closure. A captured storage instance remains bound to its original invocation and closes with it; it cannot be reused for a later retry/run. Caller interruption interrupts and awaits the managed publication child. The close barrier aborts remaining uncommitted children before task-local finalizers; completed commits remain durable. Preserve the existing finalizer timing limitation described in the binary proposal.

DI precedence stays ordinary Effect: runner provisioning overrides caller/application services outside execute; an explicit inner `Task.provide` or provideService may supply a fake/custom storage implementation. The same override must affect both new service calls and the compatibility adapter. Do not claim a user-supplied replacement automatically implements persistence, validation or the default supervisor. Task.test must make the supported substitution route clear.

## Compatibility and testing

Keep existing JSON `context.publish(name, value, options)` as a compatibility adapter to the service, resolving the named artifact and forwarding an explicit output alias. It must yield the active service at execution time so Layer substitution is consistent; it must not keep an independent publisher. New documentation uses ArtifactStorage. Do not remove context identity/progress fields or introduce unrelated service migrations here. Binary authoring is through the new service; there is no need to extend the compatibility method to bytes.

The adapter retains its public `R = never` type. Resolve the active service with `Effect.serviceOption`, falling back to the invocation's captured default when absent, so the adapter has no hidden required service. Forward the explicit named output. An inner override still wins when present; the captured fallback remains subject to its invocation's closure. Do not add ArtifactStorage to the public TaskContext method's requirements.

The production runner and Task.test automatically provide the default service. Task.test records actual publications as before (and the proposed bytes variant); a deliberately supplied fake via Task.provide controls its own behavior and does not automatically add host/harness records. No new custom test harness DSL.

Prefer the default `Task.test` implementation for task tests. Hand-written fakes are useful for standalone helper Effects, but a generic method's artifact-specific return type is not reliably checked in a non-generic fake implementation. A wrong artifact id compiled in both reviewers' probes; the consumer's overloaded stand-in also admitted a fake with an undeclared service requirement. Do not assume the revised signature eliminates that requirement gap without testing it. Simple fakes need no cast, but the Effect review's fake that consumed a generic stream needed one internal cast. These are real limits on fake ergonomics, not guarantees supplied by `ArtifactStorage.of`. The real API has not been implemented or typechecked yet.

For a standalone helper that only needs a reference, a proposed fake pattern is:

```ts
const fake = ArtifactStorage.of({
  publish: (artifact, _source, options) =>
    Schema.decodeUnknownEffect(artifact.refSchema)({
      artifactId: `test/${options.key}`,
      digest: "test-only",
      schemaId: artifact.id,
      schemaVersion: artifact.version,
      version: 1,
    }).pipe(
      Effect.mapError(
        () =>
          new TaskRuntimeError({
            code: "InvalidBoundary",
            message: "Invalid fake artifact reference",
          })
      )
    ),
});
const TestStorage = Layer.succeed(ArtifactStorage, fake);
```

This example requires `Layer`, `Schema` and `Effect` from `effect`, and TaskRuntimeError from the SDK. Keep the implementation dependency-free, derive schema identity from its artifact argument, and decode the reference through that artifact's refSchema. This validates the synthetic reference; it does not consume streams, validate input values, record publications or persist content. `ArtifactStorage.of` is the ordinary Effect service constructor, not a new fake helper. A fake shipped on a task replaces production storage just as it replaces the test recorder.

Share ArtifactStorage across host/application/extension module loaders. Stable Effect service keys support DI resolution across copies; canonical artifact membership still requires the correct definition instance. Preserve existing artifact constructor contracts and extension selection.

Identical service types from duplicated SDK copies can be excluded from task requirements; a version-skewed service with a different method shape may remain in R and surface at the Application boundary. Matching service keys do not make version-skewed APIs compatible.

## Required feasibility checks before implementation approval

- Standalone publish helpers require ArtifactStorage; JSON values and bytes sources retain correct types/references; wrong values fail; finite bytes infer E/R as never; other service requirements survive Task.make/provide/implementation.
- Simple Layer.succeed service fakes need no casts; artifact-specific reference correctness is not guaranteed by assignment, so decode through refSchema. Stream-consuming generic fakes may need one internal cast. Verify the final conditional signature against generic helpers and hidden requirements.
- Pin the known fake typing gaps with probes; do not claim that assignment checks a fake's reference identity or hidden service dependencies.
- Canonical declared membership is runtime-checked before source pulls; one alias is automatic, duplicates require disambiguation, wrong aliases/foreign definitions fail.
- Service provisioning reaches task-local helper Layer construction; the phase rule behaves coherently on acquisition failure, handler success/failure/deadline and finalization, with exact errors and no background write escaping.
- Test a Layer-forked caller while the handler is active and after closure, handler-owned cleanup publication, distinct setup/closed messages, and runner precedence over application-level storage.
- Concurrent runs/retries get separate closures and admitted tags; a captured closed service cannot publish again.
- Inner fake Layer substitution affects service calls and legacy context adapter consistently; Task.test records are not falsely promised for fake implementations.
- Existing JSON handlers remain source compatible, and schema/metadata/idempotency/inheritance behavior is identical when using either authoring surface.
- Legacy context.publish keeps R = never; application-level invocation-service requirements fail the recommended Application<never> check.

Review only this DI delta and consequential ownership/type issues. The user specifically requested the service, so preserve that direction while identifying honest static-versus-runtime guarantees. Write new review files; do not edit production code, the proposal or prior reviews.

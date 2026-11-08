# ArtifactStorage

The DI authoring path supports schema-backed JSON and [binary artifacts](binary-artifacts.md). Both support manual [retention/reclamation](artifact-retention-api-draft.md) and [opt-in automatic policy collection](automatic-artifact-retention.md). Binary publications accept Uint8Array or an Effect Stream and retain its error and service requirements.

```ts
import { Artifact, ArtifactStorage, Task } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

const Report = Artifact.make({
  id: "report",
  version: 1,
  schema: Schema.Struct({ count: Schema.Int }),
});

const Summarize = Task.make(
  {
    id: "summarize",
    version: 1,
    input: Schema.Int,
    success: Report.refSchema,
    error: Schema.Never,
    replay: "idempotent",
    outputs: { report: Report },
  },
  (count) =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      return yield* storage.publish(Report, { count }, { key: "summary" });
    })
);
```

Import the service from the SDK root or as a named export from `@offtree/effectory-sdk/ArtifactStorage`. The runner and `Task.test` provide it automatically. A standalone helper that yields it retains an ordinary Effect service requirement. Task construction, replacement implementations and `Task.provide` remove this runner-owned requirement while preserving every other service requirement.

## Publication contract

`storage.publish(artifact, value, { key, output?, tags? })` returns an Effect with the artifact's reference type and `TaskRuntimeError`. It is lazy: membership, encoding and storage occur when evaluated. The artifact determines the accepted decoded value type. Membership in the task's `outputs` is checked at runtime before encoding or storage.

Use the exact artifact definition registered in the task. Another definition with the same id is rejected with `UnknownOutput` and a different-instance diagnostic. If one definition is registered under several output names, supply `output` to select the alias. An ambiguous call fails `InvalidBoundary`; a wrong alias fails `UnknownOutput`.

`tags` accepts the existing `Tag.Input`: typed binding arrays or raw string maps. Publications inherit admitted run tags, with explicit publication tags winning. Replacing `Tag.Values` for typed reads does not rewrite the admitted metadata inherited by storage. Existing key validation, schema encoding, JSON budgets, receipt identity and lake metadata are unchanged. An identical repeat in one invocation returns the same receipt; changing content under the same key fails `PublicationConflict`.

## Layers and Scope

Publishing is allowed during task-local Layer acquisition and the handler. A setup publication that commits remains durable even if later setup or the handler fails. Resources, storage instances and Layer memoization belong to one execution attempt; a captured storage instance cannot be reused after it closes.

Use `Task.provide` for helper Layers that capture storage. Direct runner lookup overrides application-level storage. A helper built at application scope can still capture an application-level fake in its closure; that helper bypasses normal storage. Export applications with `satisfies Application.Application<never>` to catch unsatisfied requirements, while recognizing that this cannot detect deliberately supplied fakes.

The default implementation closes admissions and interrupts and awaits unfinished publications before releasing task-local Layer resources. Calls after closure fail `InvalidBoundary` with `Invocation closed`. Layer finalizers cannot publish. To publish buffered output during cleanup, use `Effect.onExit` or `Effect.ensuring` inside the handler, before its closing barrier. Cancellation and the host's run-state checks still apply; failure logs are not guaranteed to commit.

Interrupting an awaited publish interrupts its owned publication fiber and waits for cleanup. Completed commits remain durable. Cleanup can take time: this does not impose a new finalizer deadline or roll back committed artifacts.

Manually nested `Effect.scoped` and `Effect.provide` regions have their own lifetimes. Await publication inside any resource scope it depends on. The invocation owner does not extend the lifetime of resources captured by a detached publication from an earlier-closing scope. Custom Layer builders that manage and close their own nested scopes have the same responsibility.

## Compatibility and tests

JSON `context.publish(name, value, options)` remains a legacy, non-deprecated adapter. It resolves the named artifact and calls the active storage service with an explicit alias. Its public Effect still requires no service; if an author replaces the entire Effect context, it falls back to the invocation's default storage. New authoring examples use ArtifactStorage.

`Task.test` records both surfaces through the same runtime hook, including tag inheritance and publication conflicts. Prefer this path for task tests. An inner `Task.provide(Layer.succeed(ArtifactStorage, fake))` or `Effect.provideService` replaces storage for both surfaces. Such a fake replaces the test recorder and production persistence, and must own its own behavior. It does not gain the default implementation's checks or lifecycle guarantees automatically.

For standalone helpers, normal Effect service fakes are sufficient. Decode synthetic references through the supplied artifact's `refSchema` instead of relying solely on generic method assignment to check reference identity. A fake must also handle bytes artifacts: consume the stream and preserve its errors, requirements and finalizers. A JSON-only fake can silently ignore stream content; generic assignment alone does not prove a fake is correct. Prefer Task.test.

## Implementation evidence

The SDK builds the service from each execution's low-level RuntimeContext and declared outputs. It uses ordinary Effect fibers, interruption, Scope finalizers and a fresh Layer MemoMap. Task-local Layers are built with that map explicitly. The map decorates acquisition exits so a failing leaf closes publications before its resources unwind; a top-level publication also registers a close barrier with its acquisition scope. This covers failures before the Layer's successful-acquisition callback can run. Scopes and Layers opened inside an already supervised publication own their resources, not the whole invocation, preventing a nested source from closing and waiting for itself. Active ancestry is private Effect context state and expires when the operation finishes. Memo sharing remains intact within one attempt. See the [nested-scope correction and regressions](invocation-nested-scope-fix.md).

Tests cover schema/value inference, retained external requirements, aliases and foreign definitions, inherited tags, service substitution, Layer setup and finalizers, partial and parallel acquisition failure, caller interruption, concurrent invocation isolation, shared host module imports, and real-host receipt/lake parity. See `packages/core/test/artifact-storage.test.ts`, `packages/platform-bun/test/artifact-storage-modules.test.ts`, and `packages/platform-bun/test/tag-runtime.test.ts`.

Historical DI reviews remain in [the DI proposal](artifact-storage-di-proposal.md). The [approved binary contract](binary-artifacts-api-draft.md) defines bytes, downloads and storage limits.

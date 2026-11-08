# Tag value reads through Effect DI — implementation review

The user proposed `const team = yield* Team.value()`, asked that Scope and Layer ownership inform the runtime design, and explicitly requested implementation. This replaces the previously reviewed context.readTag API. Optional declarations, present-value validation, typed callable bindings, raw metadata inheritance and durable storage/query contracts stay approved. Review the narrow DI implementation contract before finalizing it; no new user approval cycle is needed for the user's requested syntax and its ordinary provisioning details.

## Public surface

`Tag.make(key, schema)` returns the same frozen callable definition, with key/codec and `value(): Effect<Option<S["Type"]>, TaskRuntimeError, Tag.Values>`. Remove context.readTag, .config and Tag.provider. Keep context.tags as the frozen raw map for inspection/publication inheritance. Definition.value captures its own key/codec; it is not an ambient global lookup.

`Tag.Values` is a required Context.Service whose service value is a readonly string map. It has no default Reference implementation. The host provisions a fresh validated/frozen snapshot for each task invocation. Outside a task, standard `Layer.succeed(Tag.Values, map)` or Effect.provideService supplies the dependency. No extra factory or custom Layer DSL. Missing service wiring remains visible in the Effect requirement and fails normally if a JS caller bypasses types. No environment fallback. Tag.value's read is suspended/lazy, checks own-key presence, returns None for absence, Schema-decodes present strings into Some, and maps SchemaError to TaskRuntimeError/InvalidBoundary with the key. Under the service's typed-map contract, raw malformed values injected by untyped callers fail decoding; the host validates the whole RunTags map before entering a handler.

User-defined Effects remain `Effect<..., ..., Tag.Values | OtherServices>`. A Task definition's execute operation supplies Tag.Values from RuntimeContext.tags, so its exposed remaining requirement is Exclude<R, Tag.Values>. Application still requires every other service. Task.test supplies fixture tags through the same execute path. Task.implementation and .provide must preserve this exclusion without widening away real dependencies.

## Layer and scope placement

The runtime owns the map per invocation/attempt, not per daemon/application revision or request fiber. A frozen map has no acquired resource, so it needs no new resource Scope. Use Effect.provideService within the invocation, not a global Layer installation or Context.Reference. Concurrent tasks and retries must not share mutable snapshots. Task child fibers inherit the invocation's Effect context through normal Effect semantics; do not invent detached fibers or a durable scope.

Task-specific .provide layers must build under the same invocation metadata service, allowing a task-local service Layer to read tags. The definition/execute wrapper therefore supplies Tag.Values around the full execution Effect, including task-local Layer provisioning, not only around the handler body. Apply its typed requirement exclusion consistently after .provide and implementation wrapping. Prefer centralizing this to avoid inconsistent fake/test/production behavior. Caller-provided Tag.Values is overridden by the runner-owned snapshot at the invocation boundary; an explicit narrower provideService inside user code still has normal Effect behavior.

Application/revision Layers build before any run and cannot depend on run metadata. A user Layer needing Tag.Values must be task-local. Do not capture an arbitrary run's metadata in a shared application Layer. Each execute installs a fresh root Layer.CurrentMemoMap to prevent reuse of application-built instances while retaining sharing within an invocation. Existing scoped Layer build and release semantics remain owned by Effect; no new memoization cache or long-lived Layer is introduced for tags. Background task ownership, resource scopes and durability beyond this immutable service remain research topics in runtime-research-queue.md, not an unsolicited migration of the whole engine.

Tag module/service/provenance must be shared by hostModuleLoaders across applications and extensions. Effect services use the stable package-qualified string key, so duplicate SDK copies can read the same Tag.Values service. Binding and declaration inputs from a foreign module copy fail provenance checks. Value reads no longer take a definition argument, so validate definition provenance at binding/declaration inputs; the closure is created only by Tag.make. No custom Tag all/default/optional combinators: use Effect.all and Option.

## Required implementation proofs

- Team.value type inference retains literal/brand/domain types; missing metadata yields None, invalid present values fail, stored 042 decodes to Some(42), and a colliding environment variable is ignored.
- A standalone Effect visibly requires Tag.Values; Layer.succeed supplies it; no custom runner APIs required. Other dependencies remain inferred through Task.make/provide/implementation and Application.make.
- Task.test and real execution supply the service without the consumer manually providing it. Its raw context.tags snapshot matches the value service.
- Two concurrent runs, retry attempts and task implementations see isolated maps. A task-local Layer may read the service at acquisition and finalization without exposing it to another run. Application Layers cannot satisfy run-metadata-dependent construction automatically.
- Cross-bundle shared module identity, typed/schema failures, async reads versus synchronous admission, fresh decoding and local Option fallbacks keep the preceding metadata review guarantees.

Review actual Task.provide/definition/Application layer composition and source types before implementation. Flag any hidden requirement erasure or ownership mismatch. Keep the public scope minimal and avoid reopening optional declarations.

Implementation outcome: see [the consolidated contract](run-tags-contract.md). Task-local Layer errors preserve TaskRuntimeError; other Layer errors retain the existing defect behavior. Low-level RuntimeContext.tags remains optional for backwards compatibility and is normalized once at execute. Explicit task-local Tag.Values providers override reads, while context.tags and publication inheritance retain the admitted snapshot.

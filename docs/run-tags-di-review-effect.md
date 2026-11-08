# Run tags DI — Effect review

Scope: only the DI provisioning delta in [run-tags-di-contract.md](run-tags-di-contract.md), checked against `packages/core/src/task.ts`, `packages/core/src/application.ts`, `packages/platform-bun/src/revisions.ts`, the host module generator and pinned `effect@4.0.5`. Optional declarations, admission, metadata and storage semantics are not reopened.

**Verdict: approve with three blocking implementation corrections (B1–B3).** The public surface (`yield* Team.value()`, required `Tag.Values` Context.Service, plain `Layer.succeed`/`provideService` outside tasks) is ordinary Effect. Nothing new is needed in the API. The defects are in how the contract's sentences map onto the current `definition()`/`provide` code, plus one memo-map sharing leak that the contract does not mention.

## Probes

Scratch probes live outside the tree, in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/a734c304-aa42-4b0a-860a-f8b4f826f5d2/scratchpad/di/`: `probe.ts`, `fin.ts`, `memo.ts` and `types.ts`, which passes `tsc --strict`.

| Probe | Result |
| --- | --- |
| `Tag.Values` provided inside `make` (handler only), `.provide(L)` wrapped outside, as in current `definition().provide` | `Die(Service not found: effectory/Tag/Values)` when L reads tags during acquisition |
| Raw run composes `.provide`; `provideService(Values)` outermost | L sees run tags at acquisition **and in finalizers**; two concurrent invocations are isolated; a die in one does not affect the others |
| App Layer builds the same `DbLive` object (Values satisfied statically), task does `.provide(DbLive)` under `provideContext(captured)` | **Task receives the app instance (`team: "APP-STATIC"`), not the run's tags.** |
| Same setup, with a fresh `Layer.CurrentMemoMap` per invocation | Task sees `"RUN"`. Nested task `.provide` calls still share within one invocation (3 builds total for app + 2 runs) |
| Current `provide` signature `Exclude<R, ROut> \| RIn` after providing a Layer that requires `Values` | `Values` leaks back into R, so Application would demand it |
| Proposed double-exclusion signature | R is exactly `Db`, then exactly `Http`. Standalone Effect shows `Values`; `Layer.succeed` removes it |

## B1 — `.provide` builds outside the tag snapshot (blocking)

`task.ts:167-170`: `provide` wraps the already-built `execute`. If `make` supplies `Tag.Values` around the handler, every task-local Layer acquires _outside_ it. That violates the contract ("supplies Tag.Values around the full execution Effect, including task-local Layer provisioning"), and a tag-reading Layer dies at runtime. Re-providing in each wrapper is also wrong, because it duplicates the boundary.

**Smallest fix:** split the stored function into an internal, non-enumerated or closure-held `run` (the Effect that still requires `Values`) and a public `execute` derived from it in exactly one place:

```ts
function definition<S extends Spec, R>(
  spec: S,
  run: (
    input: unknown,
    context: RuntimeContext
  ) => Effect.Effect<
    S["success"]["Type"],
    S["error"]["Type"] | TaskRuntimeError,
    R | Tag.Values
  >
): Definition<S, Exclude<R, Tag.Values>> {
  return Object.freeze({
    ...contract(spec),
    execute: (input, context) =>
      run(input, context).pipe(
        Effect.provideService(Layer.CurrentMemoMap, Layer.makeMemoMapUnsafe()), // B3
        Effect.provideService(Tag.Values, context.tags)
      ),
    provide: (layer) =>
      definition(spec, (input, context) =>
        run(input, context).pipe(Effect.provide(Layer.orDie(layer)))
      ),
  });
}
```

`make` passes its current `Effect.gen` as `run` and does no tag provisioning itself. `providerDefinition` already re-derives through `base.provide`, so `Implementation` inherits the behavior with no extra code. `Task.test` and the runner both reach the same `execute`, which keeps fake and production behavior aligned. The runner's `taskContext(...)` (`interpreter.ts:206`) must populate `RuntimeContext.tags` with the admitted, frozen map.

Ordering note: `Application.make` wraps `execute` in `Effect.provideContext(services)`. In 4.0.5 that is `Context.merge(current, services)` (`internal/effect.ts:2313`), so it **does not** replace inner provisions. The `provideService` inside `execute` is inner, so it wins over any `Tag.Values` an author may have put into the Application context. That is the contract's "runner-owned snapshot overrides caller-provided" rule, and it needs no extra guard. Keep it inside `execute`. Do not move it to the runner, where `provideContext` would override it.

## B2 — `provide` / `Implementation.provide` re-add `Tag.Values` to R (blocking, type-only)

`Definition.provide` returns `Definition<S, Exclude<R, ROut> | RIn>` (`task.ts:96`, `:226`). A task-local Layer that reads tags has `RIn ∋ Tag.Values`, so the exposed R regains `Values`. `Application.make`'s `Requirements<T>` then forces the author to supply it at application level, which is exactly the capture the contract forbids. **Fix:** in both interfaces, use

```ts
=> Definition<S, Exclude<Exclude<R, ROut> | RIn, Tag.Values>>
=> Implementation<S, Exclude<Exclude<R, ROut> | RIn, Tag.Values>, Id>
```

and `make`/`implementation` return `Definition<S, Exclude<R, Tag.Values>>` / `Implementation<S, Exclude<R, Tag.Values>, Id>`. Nothing else widens. `Effect.Services<ReturnType<execute>>` in `Application.Requirements` and `Extension.TaskServices` picks up the narrowed R automatically. `test<S, R>` already returns `execute`'s R. Required proof: a type test that `make(...).provide(TagReadingLayer)` exposes exactly the Layer's non-tag inputs, and a negative test that a _non-tag_ missing service is still reported by `Application.make`.

## B3 — task-local Layers can be served from the revision memo map (blocking, not in contract)

`revisions.ts:78` builds the application with `Layer.buildWithScope`. `buildWithMemoMap` installs `Layer.CurrentMemoMap` into the build fiber and the output context (`Layer.ts:780-783`). `Application.make` captures `Effect.context()` during that build, so every task invocation runs with the **revision memo map** in context. `Effect.provide(layer)` then forks it (`CurrentMemoMap.forkOrCreate`), and a fork _reads parent entries by Layer object identity_ (`MemoMapImpl.get`, `Layer.ts:431-441`). Consequences:

- If the same Layer value is provided to both `Application.provide` and `Task.provide`, the task silently gets the app-built instance. For a tag-reading Layer satisfied at app level with a static map, that means wrong metadata with no error (probe row 3).
- More generally, task-local "per-invocation" Layers are not per invocation whenever their object was also built at revision level. Acquisition counts and finalizer timing then depend on unrelated app wiring.

**Fix (one line, already in the B1 sketch):** install a fresh root memo map for each `execute`: `Effect.provideService(Layer.CurrentMemoMap, Layer.makeMemoMapUnsafe())`, inner relative to Application's `provideContext`. This keeps sharing _within_ one invocation across nested `.provide` calls (verified: 1 build per invocation), isolates attempts and runs, and leaves app Layer memoization untouched. Prefer this over `Effect.provide(layer, { local: true })`, which would also stop intra-invocation sharing between chained `.provide` calls. Do not strip `CurrentMemoMap` in `Application.make` instead: `Task.test` run under a Layer-built test context has the same exposure.

Required proof: a test where the same Layer object is given to `Application.provide` and `Task.provide`, asserting separate acquisitions and the run's tag value.

## Confirmations (no change needed)

- **Required service, no default.** Use `class Values extends Context.Service<Values, Readonly<Record<string, string>>>()("@offtree/effectory-sdk/Tag/Values") {}`, with no `Context.Reference`. Missing wiring surfaces in R, and untyped callers get the standard "Service not found" defect. Do not catch it into `TaskRuntimeError`.
- **`value()` typing.** `value: () => Effect<Option<S["Type"]>, TaskRuntimeError, Tag.Values>`, implemented as `Effect.flatMap(Effect.service(Values), …)` or by yielding the class directly. In 4.0.5, a static `.asEffect()` does not exist on services. Check `Object.hasOwn`, decode with the captured codec via `Schema.decodeUnknownEffect`, and map `SchemaError` to `InvalidBoundary` naming the key. Decode on every read; do not cache.
- **Scope.** Per-invocation `provideService` of a frozen map needs no Scope. Task-local Layers already get one through `Effect.provide` → `scopedWith`, closed on success, failure, interruption and timeout. Finalizers observe the same snapshot (probe `fin.ts`). Each retry attempt calls `execute` again, so acquisitions repeat per attempt by construction. Child fibers inherit via normal fiber context. No new memoization or long-lived Layer is introduced (B3 removes an accidental one).
- **Snapshot validity.** `Tag.Values` must hold the **same frozen object** as `context.tags`, with no second copy. A proof can assert `Object.is`. `Task.test` decodes fixtures with `RunTags`, freezes them inside its existing `Effect.suspend` (fresh per call) and passes the map in `RuntimeContext.tags`. The runner passes the admitted stored map, frozen once per attempt context.
- **Application/Extension layers.** These cannot read run metadata, by construction: they build before any run, and B2 stops task requirements from pushing `Values` into them. An author who deliberately provides `Layer.succeed(Tag.Values, …)` to an Application only affects services built at app level. Task reads still see the run snapshot (B1 ordering), and B3 prevents reuse of those app-built instances in task-local Layers. No runtime guard is needed.
- **Host module identity.** Effect resolves `Context` entries by **key string**, not class identity. A duplicated SDK copy's `Tag.Values` therefore resolves to the host snapshot, which is harmless. Do not rely on service identity for provenance. Keep provenance on definitions/bindings (a `WeakSet` as in `ref.ts`), checked at `Workflow.make` declarations and binding inputs. Add `"./Tag": "./src/run-tags.ts"` (or a dedicated `tag.ts`) to `packages/core/package.json` exports, add `Tag` to `index.ts`, and regenerate `host-modules.generated.ts` (`scripts/generate-host-modules.ts` reads exports), so applications and extensions share one module instance. Add a cross-bundle test asserting `Tag.make` provenance accepts host-loaded definitions and rejects a foreign copy.

## Implementation checklist delta

1. `task.ts`: internal `run` plus a single derived `execute` (B1, B3), and double-exclusion signatures for both `provide`s and for `make`/`implementation` (B2). Add `tags: Readonly<Record<string, string>>` to `RuntimeContext`.
2. `Task.test`: accept a `tags` fixture, validate and freeze it, and pass it through `RuntimeContext`. Add no separate provisioning path.
3. Runner `taskContext`: supply the admitted map.
4. Package exports and host modules for `Tag`.
5. Tests: probe rows 1–4 as real tests, plus the B2 type tests and the `Object.is` snapshot check, alongside the contract's existing proof list.

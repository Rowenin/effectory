# Tag value reads through Effect DI — consumer review

Scope: only the DI provisioning delta in [run-tags-di-contract.md](run-tags-di-contract.md) and how it composes with the current `packages/core/src/task.ts`, `application.ts`, `extension.ts`, `platform-bun/src/interpreter.ts` and `revisions.ts`. Optional declarations, admission, metadata framing and storage are approved and not revisited. I checked the pinned Effect 4.0.5 source for `provideContext` (`Context.merge`, so provided services win), `provideService` (`Context.add`) and `Context` lookup, which uses the key string (`mapUnsafe: Map<string, …>`).

## Verdict

From a consumer's point of view the contract is right. `yield* Team.value()` returns `Option` and visibly requires `Tag.Values`. A standalone Effect gets the service from ordinary `Layer.succeed` or `Effect.provideService`. Tasks never mention the service. Nothing new needs to be designed. The current composition code would still break that promise in two places (M1, M2) and needs four small guards (M3–M6). Implement it with these fixes. No further review round is needed.

## Must fix

### M1 — Supply `Tag.Values` outside `.provide` layers and remove it from `RIn` as well (blocker)

Today `definition()` makes `.provide` wrap the previous `execute`: `execute(input, context).pipe(Effect.provide(Layer.orDie(layer)))`. If `Task.make` supplied `Tag.Values` inside its own `execute`, which is the obvious place to put it, then a task-local Layer would be built _outside_ that service. Two things would go wrong:

- A task-local Layer that reads `Team.value()` would fail at runtime with a missing service.
- Its type `Exclude<R, ROut> | RIn` would bring `Tag.Values` back through `RIn`. That leak passes through `Effect.Services<ReturnType<execute>>` into `Application.make` and `Extension.Requirements`. The consumer would then see an Application requiring `Tag.Values` and would "fix" it by providing a fake map at application level. This is the exact capture the contract forbids.

Minimal fix: keep a private, unprovided `run` closure inside `definition()` and derive `execute` from it in one place:

```ts
function definition<S extends Spec, R>(
  spec: S,
  run: Run<S, R>
): Definition<S, Exclude<R, Tag.Values>> {
  return Object.freeze({
    ...contract(spec),
    execute: (input, context) =>
      Effect.suspend(() => {
        const tags = snapshot(context.tags); // M3: one validated, frozen object
        return run(input, { ...context, tags }).pipe(
          Effect.provideService(Tag.Values, tags)
        );
      }),
    provide: (layer) =>
      definition(spec, (i, c) =>
        run(i, c).pipe(Effect.provide(taskLayer(layer)))
      ), // M2
  });
}
```

The public types must apply the same exclusion everywhere:

- `Definition.provide` returns `Definition<S, Exclude<Exclude<R, ROut> | RIn, Tag.Values>>`.
- `Implementation.provide` applies the same exclusion.
- `make` and `implementation` return `Exclude<R, Tag.Values>`.

`providerDefinition` already delegates to `base.provide`, so it inherits the fix. `Application` and `Extension` requirement types are derived from `execute`, so they need no changes of their own. Add type tests for a task-local Layer that requires `Tag.Values | Db`: the Task's remaining requirement must be exactly `Db`, and so must the Application's.

### M2 — Do not let `Layer.orDie` turn tag read failures into defects

`.provide` currently wraps every task-local Layer in `Layer.orDie`. Suppose a Layer runs `Team.value()` at acquisition and the present value is invalid. That can happen with direct task runs, `Task.test` raw-map fixtures, linked-child keys or a codec that disagrees with the root. The read's documented `TaskRuntimeError/InvalidBoundary` then becomes a die. In the interpreter that is no longer the typed host failure; it is a defect with a different outcome category.

This is a consumer surprise: the same read fails typed in the handler but dies in a Layer. Minimal fix: in `taskLayer`, let `TaskRuntimeError` pass through as a typed failure and die only on other layer errors. Use `Layer.catch` with a `TaskRuntimeError` check that re-fails, otherwise dies. The handler's error type already includes `TaskRuntimeError`, so no public type changes. Test an invalid tag read during Layer acquisition. Also test a successful read in a finalizer.

### M3 — One snapshot, validated in the shared execute boundary, with `RuntimeContext.tags` required

- Add `readonly tags: RunTags.Type` to `RuntimeContext` and `TaskContext`. Callers that build a `RuntimeContext` must then fill it: `interpreter.ts` `taskContext()` from the run record, and `Task.test`.
- The `snapshot()` in M1 should do the generic `RunTags` decode and freeze **once**. The same object becomes both `context.tags` and the `Tag.Values` service. That makes the "raw `context.tags` matches the value service" proof hold by construction rather than by convention. The host has already validated at admission, so decoding again is cheap and keeps fake, test and production behaviour identical.
- `Task.test(task, { input, tags? })` takes `Tag.Input` (bindings or raw map), which defaults to `{}`, and goes through the same `execute`. The consumer never provides `Tag.Values` by hand for a Task. A test with a `Tag.Values` service already in its context must still see the fixture, because the runner's snapshot is supplied innermost relative to anything outside `execute`.
- Ordering against `Application`: `Application.make` wraps each task in `Effect.provideContext(services)`. In Effect 4 that is a merge in which provided services win. It sits _outside_ `definition().execute`, so the runner's snapshot still wins over anything an application-level Layer captured. Keep `Tag.Values` inside `definition()` (not in the interpreter or Application) so this order holds, and add a test where `Application.provide(Layer.succeed(Tag.Values, { team: "wrong" }))` is ignored by the task.

### M4 — Make a leaked requirement a compile error at the application export, and say where tag-reading Layers go

`revisions.ts` casts the default export's layer to `Layer<Registry, unknown>`. The comment says "authoring types check R", but nothing checks that the exported Application has `R = never`. A consumer whose `Db` Layer reads tags and is placed at application level typechecks fine. They find out only when the revision build, or a later read, fails at runtime.

Minimal fix, with no new API:

- Write examples and the scaffold as `export default Application.make({...}) satisfies Application.Application<never>`. Layer `RIn` is covariant, so this rejects leftover requirements.
- Add one sentence to the docs: "A Layer that reads run tags belongs on `Task.provide`; Application Layers are built per revision, before any run." Show a task-local Layer example that reads `Team.value()` once at acquisition.

Without this, the type requirement is visible but not enforced. The contract's "missing service wiring remains visible" would be only half true.

### M5 — Write down service priority; a task-local `Tag.Values` Layer shadows run tags

With M1's order, `Task.provide(Layer.succeed(Tag.Values, …))` is _inside_ the runner boundary. It overrides the real run tags for the handler, in production as well as in `Task.test`. The contract calls this "normal Effect behavior". That is true, but a consumer copying a standalone test pattern into `.provide` would silently ignore real metadata.

Do not add a guard API. Add one priority sentence:

1. Explicit `provideService` or a `.provide` Layer inside the task wins.
2. Next comes the runner snapshot from `context.tags` (or `Task.test` `tags`).
3. Application- or caller-level provision is ignored.

Add one test that pins this behaviour. Recommend `Task.test({ tags })` as the way to fixture Tasks, and `Layer.succeed` only for standalone Effects.

### M6 — Correct the duplicated-SDK statement to match Effect's key-string identity

Effect 4 looks services up by key string. Two SDK copies that define `Tag.Values` with the same key therefore _share_ the service, and `Team.value()` from a duplicated copy reads the real map. The contract's "duplicated SDK copy fails provenance checks rather than silently supplying a different default" still holds for bindings and declarations, which are checked by provenance. It is not a read-time failure.

Fix the wording and the proof. Bindings and declarations from a foreign copy fail with `InvalidBoundary`. Reads through any copy see the invocation's map, and with no `Reference` default an unprovided read is a normal missing-service failure. Choose a stable, package-qualified key such as `"@offtree/effectory-sdk/Tag/Values"` and never change it, because the service shape is part of cross-bundle compatibility.

## Consumer notes (doc text only, no API change)

- **Absence and errors:** carry the `Effect.fromOption` example from run-tags-metadata-api.md over, with `Deployment.value()` in place of `context.readTag(Deployment)`. `Option.getOrElse` is a local fallback, not a default. Workflow defaults show up as `Some`.
- **Standalone provisioning is raw/encoded:** `Layer.succeed(Tag.Values, { build: "042" })` with `Build.value()` gives `Some(42)`. A domain value like `{ build: 42 }` is a type error, because the service is a string map. Show this in one example so nobody expects typed fixtures outside `Task.test`.
- **Inference:** `Effect.all({ team: Team.value(), build: Build.value() })` gives `Option<string>` and `Option<number>` with a single `Tag.Values` requirement. That requirement disappears at `Task.make`, and every other service remains. This matches what consumers expect.
- **Scope:** no new Scope. `Effect.provide(layer)` per `execute` already builds task-local Layers once per attempt and finalizes them on success, failure, `timeoutOrElse` interruption or retry. Concurrent runs and retries are isolated because `execute` creates the snapshot each time. State this rather than adding machinery.

## Not requested

No `Tag.layer` or `Tag.test` helper, and no `Reference` default, environment fallback, interpreter-level provisioning or Application-level hook. None of the fixes above adds public surface beyond the contract's `Tag.Values`, `value()`, `RuntimeContext.tags` and `Task.test({ tags })`.

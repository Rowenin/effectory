# ArtifactStorage through Effect DI — consumer review, round 1

Scope: only the DI delta in [artifact-storage-di-proposal.md](artifact-storage-di-proposal.md). That covers the call shape, runtime membership, output aliases, helper Layers, the phase rule, fakes and `Task.test`, and the JSON `context.publish` adapter. Byte limits, storage, transport and retention in [binary-artifacts-api-draft.md](binary-artifacts-api-draft.md) are out of scope. The user's direction stands as given: "yield an `ArtifactStorage` service and call `publish()`". This review does not argue for `context.publish` as the primary surface.

Labels used below:

- **[source]** a fact read from the current checkout.
- **[probe]** a scratch typecheck outside the checkout, using Effect 4.0.5, the repo `tsconfig` strictness flags, and the real `packages/core/src/artifact.ts`. `ArtifactStorage` and `Artifact.Bytes` were local mocks of the proposed shapes.
- **[proposal]** text from the proposal itself.

A reviewer's approval is not the user's approval.

## Verdict: REQUEST CHANGES (doc-only; small)

The consumer shape is right. This is elegant:

```ts
const storage = yield * ArtifactStorage;
return yield * storage.publish(Csv, source, { key: "report" });
```

It matches the `Tag.Values` precedent. A reusable helper reads naturally as an Effect that requires `ArtifactStorage`. The probes confirm the main type promises (below).

Three statements need correcting before the proposal goes to the user:

- **B1** overstates what fakes guarantee.
- **B2** leaves the phase rule underspecified at the point where consumers will hit it.
- **B3** mixes public decisions with internal mechanics, so the user cannot see what they are being asked to approve.

All three are fixed by editing the doc. No production change is involved. Once they are applied, the lead can check them and present without another review round.

## What the probes confirm [probe]

- A standalone `Effect.gen` that yields `ArtifactStorage` and publishes has requirement exactly `ArtifactStorage` and error exactly `TaskRuntimeError`. The references keep their literal `schemaId` (`"report/row"` and `"report/csv"`).
- `NoInfer` on the JSON value works. `{ n: "x" }` is rejected for a `{ n: number }` artifact, and a `Uint8Array` passed to a JSON artifact is rejected.
- A finite `Uint8Array` infers `E = never` and `R = never`, not `unknown`. A `Stream` source keeps its own error (`Boom`) and service (`Svc`) alongside `ArtifactStorage`.
- Reusable generic helpers compile without casts. Two shapes were checked:
  - `<A extends Json>(a: A, v: A["schema"]["Type"]) => …publish(a, v, …)`
  - `<A extends Bytes, E, R>(a: A, s: Stream<Uint8Array, E, R>) => …`

  Both resolve the right overload, and the call site gets the literal reference type.

- A fake built with `Layer.succeed(ArtifactStorage, { publish: (artifact: Json | Bytes, _source: unknown, options) => … })` or `ArtifactStorage.of({...})` compiles **without `any` or casts**. A fake that returns a non-reference (`42`) is rejected.

## Blockers

### B1 — Say what a fake's types do not check (honesty fix)

[probe] A plain fake can only be written as one non-generic function, and assigning that function to the overloaded generic `publish` erases the generics. Two consequences follow, and both compile:

- **Requirement leak.** A fake whose `publish` returns `Effect<…, never, Svc>` is accepted. With a JSON-only (non-overloaded) signature, the same leak is rejected. What lets it through is the bytes overload's generic `R`. At runtime the fake then fails with a missing service the first time it is called.
- **Wrong reference.** A fake that returns `schemaId: "totally/else"` is accepted. The per-artifact literal reference type is not enforced inside the fake.

The proposal's feasibility list asks to "record any unavoidable ergonomics cost honestly". This is that cost. Smallest fix:

1. State both gaps in the Compatibility and testing section.
2. Document one fake pattern: `ArtifactStorage.of({ publish: (artifact, source, options) => Effect.sync(...) })`, returning `{ schemaId: artifact.id, schemaVersion: artifact.version, ... }`.
3. Recommend `Task.test` (default service, real records) over hand-written fakes for task tests. Fakes are mainly for standalone helper Effects.

Do not add a fake constructor or harness DSL for this. If the user later wants fakes checked by the compiler, that is a separate public decision, for example an exported non-generic `ArtifactStorage.Request` type.

### B2 — Specify the phase rule as admission-time, with the escape hatch named

[proposal] The service is available while task-local Layers are acquired, but `publish` is admitted only between the start of the raw handler and the start of its closing barrier. I agree with this rule. These are the alternatives:

| Model | Consumer cost |
| --- | --- |
| Provide the service only to the handler, not to Layers | Breaks the main reusable pattern: a helper Layer that captures storage for its methods. Worse. |
| Also admit publishes during Layer acquisition and finalization | The supervisor would have to wrap the Layers and close after source Layers release. That reintroduces the ordering hazard the binary proposal solved, and needs an owner for a failed acquisition. More machinery, and harder to explain. |
| Admit during acquisition only | An asymmetric rule ("acquire yes, release no") that consumers will misremember. |
| **Proposed: yield anywhere, publish while the handler runs** | One sentence to explain. The only real loss is "publish from a finalizer". |

So the rule is the simplest complete model, but the doc must pin down three things consumers will run into:

1. **Admission is decided by time, not by caller.** Say this explicitly: a fiber that a helper Layer forked in its own scope may publish while the handler is running. Its publication child is still registered with, and closed by, the handler's supervisor. After close, the same fiber gets the closed error. Without this sentence, readers will assume calls are checked by Scope or by fiber.
2. **Name the alternative to finalizer publishing.** The plausible case is "write captured logs as an artifact on failure". The supported route is inside the handler:

   ```ts
   handler.pipe(
     Effect.onExit(() => storage.publish(Log, buffered, { key: "log" }))
   );
   ```

   It can equally be an `Effect.ensuring`, or a scoped region that is closed inside the handler. Those run before the barrier. Show one example next to the rule.

3. **Use two distinct messages.** Keep `InvalidBoundary` as the code, but name the phase in the message: "publication is not available during task Layer acquisition; publish from the handler" and "invocation closed". A rejected acquisition-time publish is a `TaskRuntimeError`, so `taskLayer` already passes it through as a typed failure instead of a die [source: `task.ts` `taskLayer`]. Say so, so nobody expects a defect.

Frame the restriction for the user as a **public decision**. It is visible, consumer-facing behavior, not an internal detail.

### B3 — Separate the user decisions from the mechanics

The proposal reads as one undifferentiated contract. Before presenting it, add a short "Decisions for the user" list. Everything else belongs under internal mechanics. My split:

**Public decisions (needs user discussion):**

1. Signature `storage.publish(Definition, value | source, { key, output?, tags? })`. Write `tags?` into the options type explicitly. The proposal only mentions it in prose ("explicit publication tags keep the reviewed precedence").
2. Declared-output membership is **checked at runtime only**. This is a deliberate regression from `context.publish`'s compile-time key filtering. It is the honest price of a global service. State it in one line.
3. The optional `output` alias is required only when one artifact instance is declared under several names.
4. The phase rule (B2).
5. `context.publish` is kept as a JSON-only adapter, and new docs use `ArtifactStorage`. Decide whether docs label it deprecated or just "legacy". I recommend "legacy, not deprecated" for now.
6. A fake supplied through `.provide` replaces recording in `Task.test` (B1), and `.provide` on the shipped definition also replaces production storage. This mirrors Tag M5.

**Internal mechanics (no user discussion needed):** supervisor placement, the commit fence, membership checked before any source pull, the fresh memo map, the stable service key `@offtree/effectory-sdk/ArtifactStorage`, the adapter yielding the active service, and sharing across module loaders.

## Non-blocking consumer notes

- **Membership by identity.** [source] The application and extensions already reject noncanonical artifacts (`application.ts`, `extension.ts:276–279`). Identity matching is therefore consistent with today's rules, not a new strictness. The new failure mode is a handler that imports a _copy_ of the definition: the name-based `context.publish` accepted it, and `storage.publish` will fail it. Make that `UnknownOutput` message say "an artifact with id `report/csv` is declared, but by a different definition instance". Then the cause is obvious. Also, `UnknownOutput` is a deterministic programming error, so retries should not hide it.
- **Duplicate aliases.** [source] No example or test in the repo declares one artifact under two output names. `output?` is still the right minimal answer, because those maps are legal today and the adapter needs the alias internally anyway. A smaller-looking alternative is to reject duplicate instances in `outputs` at `Task.make`. It would remove the option, but it breaks currently legal definitions. Present it as an alternative under decision 3 rather than adopting it silently.
- **Application-level capture.** [source] `examples/tagged/effectory.ts` already uses `satisfies Application.Application<never>`. Carry the Tag M4 sentence across: "A Layer that yields `ArtifactStorage` belongs on `Task.provide`." Show an application Layer that captures storage failing that `satisfies` check. A user `ArtifactStorage` provided at application level is silently overridden by the runner's service. Include that in the precedence test, as Tag M3 did.
- **Stale capture.** It only arises from an escaped reference (a module-level variable, a `Ref`, or a closure kept past the attempt), because task-local Layers are rebuilt per attempt [source: `execute` builds a fresh memo map]. The proposal's closed-invocation error covers it. No API needed.
- **Accessor sugar.** Do not add a static `ArtifactStorage.publish(...)` accessor. The two-line `yield*` form is what the user asked for, and it matches `Tag.Values`, which also has no accessor.
- **Name.** `ArtifactStorage` with only `publish` invites readers to expect `get` and `query` methods. The user chose the name, so keep it. Add one line saying reads stay on `Lake`/CLI in this slice.
- **Adapter typing.** `TaskContext.publish` must keep `R = never`. Discharge the adapter's internal `ArtifactStorage` requirement inside `make`, not through a public type. Test that an inner `.provide(fake)` is observed by both `storage.publish` and `context.publish`, as the proposal requires.

## Not requested

No `forTask`, per-task tag factory, capability DSL, test harness helper, fake constructor, accessor, or `Reference` default. None of the fixes above adds public API beyond what the proposal already lists.

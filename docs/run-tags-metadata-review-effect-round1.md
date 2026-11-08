# Run tags metadata reading API — Effect review, round 1

Reviewer: Claude (Effect POV). Target: [run-tags-metadata-api.md](run-tags-metadata-api.md), read together with [the approved contract](run-tags-contract.md) and [the typed review](run-tags-typed-review-effect-round1.md). This reviews a proposal only. I edited no production or unrelated files and committed nothing. Reviewer approval is not user approval, and no implementation is authorized by it.

## Verdict

**Approve for presentation, with four small text corrections (M1–M4).** None changes the shape of the API, and none needs another Effect round.

The revision is smaller and more idiomatic than the Config-based surface it replaces:

- It drops `.config`, `Tag.provider`, `context.readTags(config)` and the ambient-ConfigProvider hazard. That hazard was F1 in the typed review: yielding `.config` silently read `process.env`.
- In its place is one method, `context.readTag(def): Effect<Option<A>, TaskRuntimeError>`, built from direct primitives: `Effect.suspend`, `Schema.decodeUnknownEffect`, `Effect.asSome`, `Effect.mapError`, and `Option` for absence.
- It adds no Layer, service, combinator family or yieldable definition.
- `Option` is the right model for absence. Absence is expected for optional bare declarations, so it should not travel the error channel. A `NoSuchElementError` or a required-read mode would bring back the late-failure tradeoff that the user rejected.

The consumer framing also works: tags read as labels you can look at, not settings you are configured by.

## Evidence

I checked against the pinned `effect` 4.0.5 in this worktree with Bun 1.4.3 and the repo's `tsc`. The probe is outside the source tree at `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/e47c5758-eedb-4a7c-ba57-8bc296e866cc/scratchpad/probe/probe.ts`. It uses a hand-written stand-in, because the real Tag API does not exist:

- a callable `Definition<Key, S>` exposing `key` and `codec`;
- a WeakSet provenance registry;
- `readTag` written as `Effect.suspend` → provenance check → `Object.hasOwn` → `Schema.decodeUnknownEffect(codec)` → `Effect.asSome` → `mapError` to TaskRuntimeError.

What the probe shows is evidence of feasibility, not a test of the real implementation. Each item is marked **[probe]** (I ran it), **[source]** (I read the code) or **[inference]** (my reasoning, not tested).

### Inference

- [probe] The proposed signature `readTag<Key extends string, S extends Boundary>(d: Definition<Key, S>): Effect<Option<S["Type"]>, TaskRuntimeError>` infers correctly. It typechecked with no errors, and both `@ts-expect-error` negative checks held:
  - `Int` reads as `Option<number>`.
  - `Literals(["dev","prod"])` reads as `Option<"dev" | "prod">`; assigning `Some("staging")` is a compile error.
  - A branded `NonEmptyString` keeps its brand; assigning `Some("a")` is a compile error.
  - `NullOr(String)` reads as `Option<string | null>`.
- [probe] `Effect.all({...})` keeps the heterogeneous record `{ team: Option<TeamId>; build: Option<number>; … }`, and its error type is exactly `TaskRuntimeError` with `R = never`.
- [probe] A generic helper `<S extends Boundary>(d: Definition<string, S>) => ctx.readTag(d).pipe(Effect.map(Option.getOrElse(() => "none" as const)))` infers `Effect<number | "none", TaskRuntimeError>`. Passing a literal-keyed definition to a `Definition<string, S>` parameter compiles.
- [source] The handler's error channel is `NoInfer<S["error"]["Type"]> | TaskRuntimeError` (`packages/core/src/task.ts:181`). So `readTag` needs no mapping under `error: Schema.Never`, as the delta claims.
- [inference] The `Key` type parameter does not affect the result. Keeping it is harmless; see M4.

### Option semantics

- [probe] Absent key → `None`.
- [probe] `"03"` with Int → `Some(3)`.
- [probe] `""` with String → `Some("")`; `""` with NonEmptyString → typed failure.
- [probe] `"null"` with `NullOr(String)` → `Some(null)`, so the outer `Some` is kept.
- [probe] A `toString` key over `{}` → `None`, because the read checks own keys with `Object.hasOwn`, not `in`.
- [inference] `Some(undefined)` is reachable only through a custom codec: the typed review's probe showed `toCodecStringTree(UndefinedOr(...))` rejects `undefined`. The delta's rule is still correct, and the proof can use a custom codec.

### Laziness, errors and async

- [probe] Wrapping the read in `Effect.suspend` means nothing is evaluated before the Effect runs. Each evaluation decodes again, so no decoded value is shared between reads.
- [probe] A forged definition (callable, with the same key and the same `codec` object) fails through the typed channel.
- [probe] A custom decoder that throws stays a `Die`; it is not mapped to a typed failure. This matches delta 4.
- [probe] An async decoder (`SchemaGetter.transformEffect` with `Effect.delay`) succeeds through the read: `Some("X")`.
- [probe] The same codec under `Schema.decodeUnknownExit` gives `Die(AsyncFiberError)`. That is the synchronous Exit/Cause classification the contract already relies on for admission and binding.
- [probe] The SchemaError message for a leaf string codec has **no key path**, for example `Expected a value with a length of at least 1`. Prefixing the tag key, as delta 4 requires, is therefore necessary, not cosmetic.
- [source] `TaskRuntimeError` has only `code` and `message` (`packages/core/src/errors.ts`). "Retaining the issue" can only mean the rendered issue text; see M2.

### Canonical codec, and removing Config

- [source] `Schema.String.pipe(Schema.decodeTo(Schema.toCodecStringTree(schema)))` uses only Schema. With `.config` gone, nothing in the tag path imports `Config` or `ConfigProvider`. `toCodecStringTree` is a Schema transformation and does not depend on Config, so delta 9's framing is accurate.
- [inference] Making definitions non-yieldable, with no ambient lookup, removes the whole class of environment-read mistakes rather than documenting around it. This is the strongest improvement in the revision.

### Provenance across bundles

- [source] Application and extension bundles get SDK modules through `hostModuleLoaders` (`packages/platform-bun/src/host-modules.generated.ts`), so the host shares one SDK instance. A module-private WeakSet works across bundles only if the new `Tag` module is one of those shared host modules, and only if the registry it writes is the same instance `contextFor` checks. See M3.

## Corrections before presentation

- **M1 — List the superseded contract passages.** Delta 1 removes the Config surface, but `run-tags-contract.md` still states it as approved. List the passages that the metadata revision replaces, so implementers and test authors don't keep Config cases:
  - "Authoring and reading": the `Config.all` example, `.config`, `Tag.provider` and `context.readTags`, plus the paragraph beginning "Config.withDefault/option handle absence".
  - "Admission and schedules": "A required Config read may still fail…" and "…may expose an absent value to a required handler read".
  - "Effect error handling": "Task Config reads remain Effects and can run async decoders".
  - "Verification": "absent boolean with Config default succeeds", and "Task reads use run tags despite colliding environment variables; optional Config reads/defaults work".

  Map each to its readTag equivalent: an absent tag gives `None`, and `Option.getOrElse` supplies a local fallback. Keep one environment-collision proof: with `process.env[key]` set and the tag absent, `readTag` returns `None`. A table in the delta is enough; the historical contract stays unedited, as the delta says.

- **M2 — Error mapping wording.** In delta 4, replace "retaining the issue" with: "`code: "InvalidBoundary"`, with a message of the form `Invalid run tag \`<key>\`: <SchemaError message>`, bounded. No new error field or class." Also state that the provenance check runs inside the suspended Effect, so calling `readTag(forged)` without running the result never throws.
  - Add a proof that `context.readTag(forged)` returns a value without throwing.
- **M3 — Provenance across bundles.** Add a proof and an implementation note:
  - The Tag module, for example `@offtree/effectory-sdk/Tag`, must be in `hostModuleLoaders`. Its registry must be the same module instance that `contextFor` checks, for example a core internal re-exported through the SDK.
  - Proof: a definition exported by an extension and read in an application task, and the reverse, both succeed.
  - Proof: a definition from a bundled duplicate copy of the SDK fails with InvalidBoundary, not silent `None`.
- **M4 — Signature and companion guidance (optional text).**
  - It is fine to state the signature as `readTag<S extends Boundary>(definition: Tag.Definition<string, S>)`; the probe shows it infers identically. Either form is acceptable; just remove "actual inference must be verified" once tested.
  - In delta 8, warn that `Schema.decodeUnknownOption` (or `Effect.option`) on the codec collapses _invalid_ values into `None`. Outside handlers, use `decodeUnknownEffect`/`Exit` together with `Record.get` / `Object.hasOwn`, which keeps invalid distinct from absent.
  - In delta 5, call async read decoding incidental: present declared values with async codecs are rejected at admission, so recommend synchronous codecs everywhere.

## Not required

- A `Tag.read(context, def)` free function or a `def.read` method. A method on the context is the idiomatic place for a capability that depends on the attempt.
- `Effect.all` with `{ mode: "validate" }` guidance. Fail-fast is the right default; Effect users already know the option.
- A cache of decoded values. Re-decoding at most 32 values of at most 256 units each per read is negligible, and a cache would reintroduce the risk of a shared mutable value.

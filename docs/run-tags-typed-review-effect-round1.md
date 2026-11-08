# Typed run tags — Effect review, round 1

Reviewer: Claude (Effect POV). Target: [run-tags-typed-api-draft.md](run-tags-typed-api-draft.md), revision 1. The [string-map baseline](run-tags-api-draft.md) is assumed for storage and semantics. This is a review of a proposal only. No production files were edited and nothing was committed. Reviewer approval is not user approval, and no public implementation is authorized.

## Verdict

**Request changes (small).** The design reuses real Effect primitives in the right places: a Schema codec, a real `Config.Config`, a real `ConfigProvider`, `Config.all`, `withDefault` and `option`. The wrappers it adds are thin and justified. Five corrections (F1–F5) are needed before the draft goes to the user. All are contract or documentation fixes; none needs a new API family. If F1–F5 are applied as written, the draft can be presented without another Effect round.

## Evidence

Every check ran against the pinned `node_modules/effect` 4.0.5 sources in this worktree with Bun 1.4.3 and the repo's `tsc` (TypeScript 7.0.2). The scratch files are in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/8b475891-91fa-45be-9ec1-4b753bd17676/scratchpad/tagprobe/` (`runtime.ts`, `ast.ts`, `nul.ts`, `eq.ts`, `types.ts`). Each item below is marked:

- **[source]**: I read the Effect or Effectory source.
- **[probe]**: a scratch runtime run or typecheck of existing Effect primitives, or of a hand-written `declare`d Tag signature. This is not the real Tag API, because it does not exist yet.
- **[inference]**: my reasoning, not tested.

### Codec composition: `Schema.String.pipe(Schema.decodeTo(Schema.toCodecStringTree(schema)))`

- [probe] Works as claimed:
  - Int 3 encodes to `"3"`. `"03"` and `"1e1"` decode to 3 and 10. `" 3"` and `""` are rejected.
  - Boolean encodes to `"true"`/`"false"` and rejects `"yes"`.
  - Literals, brands, `NumberFromString`, Date (ISO string), BigInt and `Literal(3)` all work.
  - `fromJsonString(Struct)` encodes to JSON text.
  - Plain Struct and Array fail with "Expected string".
  - `UndefinedOr` rejects `undefined`.
  - `Schema.Number` encodes NaN as `"NaN"` and Infinity as `"Infinity"`.
- [probe] Its type is assignable to `Schema.Codec<S["Type"], string, never, never>` for `S extends Boundary`. Boundary is `Schema.Codec<unknown, unknown, never, never>` (`packages/core/src/boundary.ts:6`).
- [source] `Config.schema` applies `toCodecStringTree` itself (`Config.ts:1314`). Passing it the string-composed codec is still correct, and better than passing the raw schema: the binder and the reader then share exactly one leaf-string encoding, so a Struct schema cannot read a nested provider object that a binding could never produce.
  - [probe] With the composed codec, `Config.schema` reads a nested provider value as "Expected string". The raw schema would read the nested shape instead.
  - Consequence: with the composed codec, `Config.schema`'s construction-time rejection never fires. [probe] `Config.schema(composed(Schema.MutableJson))` and `composed(Schema.Unknown)` both construct without error. See F5.
- **[probe] Lossy round-trip (new finding, see F2).**
  - `NullOr(String)`: the string `"null"` encodes to `"null"` and decodes back as `null`.
  - `Union([Int, String])`: the string `"3"` decodes back as the number 3.
  - The draft's check ("the encoded value can decode") passes both cases, but the decoded value differs from the input.
  - `Schema.toEquivalence(schema)(value, decoded)` catches both. It returns true for Int, brand, Date, `fromJsonString(Struct)`, NaN and -0.
- [probe] Asynchronous transformation: a `SchemaGetter.transformEffect` with `Effect.delay` makes `encodeUnknownSync` throw a plain Error, "Sync adapter can only throw schema errors". It is not a SchemaError. The DefinitionError wrapping must therefore write its own clear message ("tag `k` codec must encode synchronously") rather than forwarding this text. [source] Config decoding at read time is Effect-based and handles async, as the draft states.

### Config / ConfigProvider composition

- [source] `Config<T> extends Effect.Effect<T, ConfigError>` with `parse(provider)` (`Config.ts:113`). Yielding it resolves `ConfigProvider.ConfigProvider` from context, and that reference defaults to `fromEnv()` (`ConfigProvider.ts:351–353`). `fromEnv` joins path segments with `_` (`ConfigProvider.ts:1165`).
- [probe] Behavior over `fromUnknown(map, { preserveEmptyStrings: true })`:
  - `withDefault`: an absent key gives the default. A present invalid value fails, including `""` for a Boolean. The draft is correct here.
  - `option`: an absent key gives None. A present invalid value fails. The draft is correct here.
  - Dotted and slashed keys resolve as one segment, whether the path is `["deployment.region"]` or the string form. The draft is correct here.
  - `NonEmptyString` over `""` fails with the key in the issue path.
  - `ConfigError.message` reads like `SchemaError(Expected "dev" | "prod"\n  at ["env"])`. It includes the key and is bounded by the schema's own message.
- **[probe] Ambient provider hazard is real (see F1).** I set `process.env.env = "prod"` and yielded `Config.schema(Environment, ["env"]).pipe(Config.option)` with no provider. It returned `Some("prod")` from the process environment.
  - In the daemon, `yield* Environment.config` would silently read daemon environment variables, not run tags.
  - With `withDefault` it would silently return the default.
  - [probe] It also typechecks inside `Task.make` (shown with `Effect.orDie`).
- **[source]/[probe] `fromUnknown` holds its root by reference** (`ConfigProvider.ts:1061–1066`). Mutating the map after creating the provider changed the value read from 1 to 2. `Tag.provider` must copy the map, which the draft promises. Keep that promise and test it.

### Typing: callable binding, NoInfer, Config.all, Task.make

[probe] I typechecked a `declare`d sketch: a `Definition<Key, S>` call signature, a `Binding<Key>` opaque through a module-private `unique symbol`, and `make<const Key extends string, S extends Boundary>`. Every expectation held:

- The key is retained as the literal `"env"`.
- `Shard("3")`, `Environment("production")` and `DryRun("false")` are compile errors.
- A structurally forged `{ key, value }` is not assignable to `Binding`.
- A heterogeneous array is assignable to `ReadonlyArray<Binding>`.
- `Config.all({...withDefault, option})` infers `{ environment: "dev" | "prod"; shard: number; dryRun: boolean; label: Option<string> }`.
- `.parse(provider)` has `R = never`.
- In `Task.make` with `error: Schema.Never`, an unmapped `ConfigError` is a compile error, because the handler's error channel is `NoInfer<S["error"]["Type"]> | TaskRuntimeError` (`task.ts:208–219`). Mapping it to `TaskRuntimeError` compiles.

Notes:

- [inference] `NoInfer<S["Type"]>` on the definition's call signature is a no-op, because S is fixed when `make` runs. "Cannot widen S" holds because `make` has only one inference site, the schema. Keeping `NoInfer` is harmless, but the draft should not credit it with the protection.
- [probe] Ergonomics: a branded schema needs `Team(TeamId.make("a"))`. `Team("a")` is a compile error. This is correct Effect behavior, but the consumer docs should show it.
- [inference] Type-level opacity does not stop runtime forgery from JS or `as any`. "Only make-created bindings are valid" needs a runtime check, for example a module-private WeakSet, applied wherever a `Tag.Input` array is accepted.

### Error channels and Task.make integration

- [source] `ConfigError` is a plain class with `_tag: "ConfigError"` (`Config.ts:76–89`). It is not a Schema class, so it cannot be a declared task error without mapping. The draft's `Effect.mapError` → `TaskRuntimeError` example is correct. `Effect.catchTag("ConfigError", …)` also works.
- I find the boilerplate acceptable. A small `Tag.parse(config, tags) = config.parse(Tag.provider(tags))` helper is optional (see F1). Do not add mapping, default or optional combinators.
- **[inference from source] Synchronous throws inside handlers become defects (see F3).** `Tag.make` and binding calls throw DefinitionError synchronously, and the draft makes `Tag.provider` throw on invalid maps. That is fine at module scope, where it matches the existing definition-time behavior.
  - Inside a handler's `Effect.gen`, a throw becomes a defect, not a typed failure. Two in-handler uses are encouraged by the draft: `context.publish(..., { tags: [Label(dynamic)] })` and `Tag.provider(rawMap)`. Either can die with a DefinitionError named for definition time, rather than failing with `TaskRuntimeError`/`InvalidBoundary` like the rest of the publication path (`task.ts:110–122`, `contextFor`).

### Unnecessary wrappers vs. Effect primitives

- `codec` and `config` expose real Effect values. Good.
- `Tag.provider` reduces to `ConfigProvider.fromUnknown(copy, { preserveEmptyStrings: true })`. It is justified only by the empty-string default and the snapshot. It should not be a second validator; see F3.
- I found no unnecessary new parser, Layer or service. A Layer or `ConfigProvider.layer` that replaces the handler's ambient provider would be wrong, because it would hide the user's real configuration. The draft correctly avoids it.
- A smaller design that still meets the user's request is not available. Removing the callable binding would contradict the request. Removing `.config` would discard the Config reuse the user asked for.

### Registry-free CLI semantics

- I agree the semantics are coherent: wire values are exact strings, typed reads fail late, and there is no canonicalization. They also preserve the baseline's fingerprint and filter guarantees.
- [probe] Late failure is concrete: `--tag dry-run=` is admitted and then fails `DryRun.config.pipe(withDefault(false))`, because the empty string is a present, invalid value.
- [inference] The draft's justification ("the CLI does not ship codecs") is incomplete. The daemon hosts the user's definitions, so admission-time validation is technically feasible later, without the CLI. For example, a workflow could declare `tagSchemas: [Environment, Shard]`, checked by the daemon at admission. The user should be told that this deferral is a choice, not a limitation, because the user explicitly asked for a stronger type. Not a blocker if presented that way; see F4.

## Required fixes before presentation

- **F1 — Ambient provider hazard.** In contract 6, state that `yield* Tag.config` (or any Config composed from it) reads Effect's ambient ConfigProvider. Inside the daemon that is `fromEnv`, so it silently returns a process environment variable or the `withDefault` value. This was verified in a probe. Requirements:
  - Every example uses `.parse(Tag.provider(context.tags))`.
  - Add a required proof: a handler test where `process.env[key]` is set and the tag is absent, showing that `.parse(...)` reads the run tag and does not fall back.
  - Optional, at the author's discretion: `Tag.parse(config, tags)` as a one-line alias, so the safe path is also the shortest. It must return the unmapped `Effect<A, ConfigError>`.
- **F2 — Lossy round-trip.** In contract 5, replace "the encoded value can decode" with "the decoded value equals the input under `Schema.toEquivalence(schema)`". This rejects `NullOr(String)("null")` and `Union([Int, String])("3")`, as shown in a probe. Add both to required proof 2.
- **F3 — In-handler errors.**
  - `Tag.provider` should take an already-typed `Readonly<Record<string, string>>`, copy it and freeze it, and not throw. Present invalid values surface as `ConfigError` from `.parse`.
  - Document that a binding call inside a handler throws synchronously, which becomes a defect. Dynamic in-handler values should use `Effect.try(() => Label(v))`, or `Schema.encodeEffect(Label.codec)` with a raw map.
  - `contextFor` normalizes `Tag.Input` to a map before `runtime.publish`, so `RuntimeContext.publish` keeps its map type.
  - Add a proof that a bad dynamic publication label is a typed failure when the documented pattern is followed.
- **F4 — Registry-free framing.** In contract 10, replace "the CLI does not ship codecs" with an explicit user decision: either deferred daemon-side admission validation against workflow-declared definitions, or late Config failure only. Name the empty-value case (`--tag dry-run=`).
- **F5 — Construction claims.**
  - In contract 4, delete "Config.schema may itself reject unsupported declarations at construction". With the composed codec it does not: `MutableJson` and `Unknown` construct fine in a probe.
  - In contract 5, the async failure message must be Effectory's own text, because Effect's text is "Sync adapter can only throw schema errors".
  - Note that `NoInfer` on the call signature is decorative, and that brands need `Schema.make`.
  - Require runtime binding provenance, such as a WeakSet, not only type opacity.

## Not required

- Construction-time detection of non-string schemas. The StringTree encoded AST tags vary: String, Union of Literal, Literal, Objects, Arrays, Declaration. Detecting them needs a small recursive walker, which the draft deliberately avoids. Failing late at bind or read time is acceptable as disclosed.
- Canonicalizing CLI strings. Exact-string semantics are correct for fingerprints and filters.

# Run tag admission — Effect review, round 1

Reviewer: Claude (Effect POV). Target: [run-tags-admission-contract.md](run-tags-admission-contract.md), revision 1. The scope is limited to the final admission additions and their consistency with [the typed proposal](run-tags-typed-api-draft.md) and [the baseline](run-tags-api-draft.md). Settled baseline features were not re-reviewed. No production files were edited, no files were reset, and nothing was committed. Reviewer approval is not user approval.

## Verdict

**Approve, with three small text corrections (A1–A3).** None changes the direction the user approved ("yes lgtm"), and none is a material redesign. The contract reuses Effect primitives where it should: Schema codecs, `Schema.toEquivalence`, `Config` and `ConfigProvider`, and `Schema.toJsonSchemaDocument`. It adds no validator, AST walker, optional-declaration DSL or registry. **Another Effect round is not needed** if A1–A3 are applied as written. The consumer review is still separately required.

## Evidence

Effect is pinned to 4.0.5 (`node_modules/effect/package.json`). I ran Bun 1.4.3 and the repo's `tsc`. The probes were temporary files in the worktree, deleted afterwards, plus a copy under the scratchpad. Labels: **[source]** means I read the current code. **[probe]** means I ran it against real Effect or a `declare`d Tag sketch. **[inference]** is reasoning I did not test.

### Admission order and dedup timing (points 12–14)

- [source] `packages/platform-bun/src/runner.ts:220–258` already follows the order in point 12. `store.lookupSubmission` runs first and returns an existing receipt before `catalog.get(request.revision)` or any definition is loaded. Next come definition resolution and one synchronous `Effect.try` boundary for input and policy. Then `store.submit(request, application.revision, …)` pins the resolved revision. Tag merging and decoding fit into that same pre-admission slot, and the defaults come from the same `application` object that gets pinned. The claim that "a retry returns the original receipt before loading new defaults or declarations" therefore holds.
- [source] The fingerprint in `host-store.ts:1018–1040` covers `input`, `kind`, `revision` and `targetId`. Adding only caller-supplied tags, as the baseline says, is consistent with point 12.
- [source] The existing `Effect.try` catch at `runner.ts:244–255` throws away the cause and returns a generic "Input or execution policy is invalid or unsupported". Point 14 wants a bounded message that names the key and the Schema issue. Tag validation therefore needs its own mapping and must not join that catch. See A1.
- [source] Scheduled admission (`schedule-store.ts:453`) calls `host.submit` directly inside the occurrence transaction. It does not re-decode input there. Point 17's statement that the occurrence transaction uses the already-validated stored configuration and loads no author code matches current behavior.

### Sync-only admission versus async Config (point 15)

- [source] Existing authored and admission boundaries are already synchronous: `boundary.ts` `encode`/`decode` use `*UnknownSync`, and admission input decoding goes through `decode`. Requiring tags to be synchronous in every mode keeps that rule. It also avoids the inconsistency of an async codec being accepted at manual admission while being rejected by `WorkflowSchedule.make`. I agree with the restriction.
- [probe] For a codec with an async `SchemaGetter.transformEffect`:
  - `Schema.decodeUnknownSync` throws a plain `Error("Sync adapter can only throw schema errors")`.
  - `Schema.decodeUnknownExit` returns a failure whose cause is a **Die** (`AsyncFiberError: An asynchronous Effect was executed with Effect.runSync`), with `Cause.hasFails === false`.
  - An ordinary invalid value (`Int` over `"-1"`/`"oops"`) returns a **Fail** with a `SchemaError`, and its message is, for example, "Expected a string representing a finite number".
  - `Config.schema(codec, [k]).parse(ConfigProvider.fromUnknown(…))` reads the same async codec without error, because reads are Effect-based.
- So Effect already provides the exact classifier the contract needs: Fail means an invalid value, and Die means the synchronous-boundary restriction was violated. Nothing needs to inspect message text. See A1.
- [inference] A bare declaration has no value at construction, so an async codec on a bare declaration can only be detected at the first manual admission or at `WorkflowSchedule.make`. The contract allows for this, but it does not say which OperationError code is returned. The fault belongs to the author, not the caller. See A1.

### Required bare declarations, defaults, no optional DSL (points 1–5)

- I agree. Requiredness lives on the declaration, so a declared key always meets a required `Config` read. Reader-side `withDefault`/`option` stays a pure read concern and is not reused as a workflow default, which matches Effect's semantics where Config defaults only cover absence. The `Object.hasOwn` presence check before decoding is right: otherwise an absent key would be decoded as `undefined`, and `UndefinedOr`/`NullOr` schemas would quietly satisfy presence.
- No optional-declaration DSL: acceptable from the Effect POV. The other Effect-native option would be to accept a `Config` program, for example `Shard.config.pipe(Config.option)`, as a declaration. But `Config` is opaque, so admission could not introspect it without running it against a provider, and doing that would turn reader programs into admission policy. The stated workaround is to leave the key undeclared and use `Config.option` at read time. Together with the explicit limitation, this is coherent. It is a user-visible limitation, not a defect. The presentation should say so plainly, as point 4 does.
- An empty string counts as present (point 5). This matches the reader's `preserveEmptyStrings: true` from the typed draft, so admission and reads agree.

### Captured definitions, typing, provenance (points 6–11)

- [probe] With a `declare`d sketch (`Definition<K, S>` callable, opaque `Binding<K>`), I checked the following:
  - `[Env("dev"), Shard]` is assignable to `ReadonlyArray<Definition<string, any> | Binding> | Record<string,string>`.
  - `Env("production")` is a compile error.
  - A bare definition is rejected by `ReadonlyArray<Binding>`, which is `Tag.Input`.
  - An array that mixes in a raw `{ shard: "3" }` is rejected.
- [probe] The non-`any` existential `Definition<string, Boundary>` **rejects** concrete definitions. The reason is that the call parameter is contravariant: `unknown` is not assignable to `"dev" | "prod"`. Point 6's "existential generic aliases" must therefore use `any` in the schema position, or an equivalent. That is fine because every call is checked at the place the user writes it, before the binding goes into the array.
- [probe] A plain function decorated with `key`/`codec`/`config` is also assignable to that existential. This confirms that point 9's runtime provenance check, a module-private WeakSet covering both definitions and bindings, is required and not just defensive. The verification list already includes this case.
- [probe] `{ env: Env.codec, shard: Shard.codec }` is assignable to `Readonly<Record<string, Schema.Codec<unknown, string, never, never>>>`. Erasing per-key types in `tagSchemas` is acceptable. Inference stays at the binding call site, and the host only needs codecs.
- [source] `Application` (`packages/core/src/application.ts:77–81`) rejects a schedule whose `workflow` is not the same object as the registered workflow with that id ("Noncanonical workflow"). `WorkflowSchedule.make`'s validation against `spec.workflow.tagSchemas` therefore uses exactly the root declarations of the revision being loaded. This is the trust basis for point 17. See A2.
- Point 11 is coherent: the root's captured codec is authoritative, a schedule override built from a different definition is checked only by decoding, and equivalence is checked only when a binding is created.

### Schema equivalence and preservation of the raw string (point 13)

- I agree. `Schema.toEquivalence` needs an original decoded value, so it applies only when a binding is created. Raw strings at admission are decode-validated and stored byte-for-byte, so `03` stays `03`. This keeps the baseline's fingerprint and exact-filter guarantees. No canonicalization should be added.

### Schedules, revisions, durability (points 16–18)

- [source] The schedule digest is `hash(identity)`, where identity is `ScheduleConfiguration` minus `description` (`schedule-store.ts:321–336`). Tags must be removed in the same way as `description`. Declarations and codecs are never part of `ScheduleConfiguration`, so they cannot affect the digest. `workflowVersion` is still in the digest, which preserves the generational effect of a version bump. Point 16 is consistent.
- [source] `reconcile` (`schedule-store.ts:302`) runs entirely inside `database.transaction`. Point 17 says reconciliation "validates the captured effective map using the observed revision's definitions before storing it". Running author codecs inside that SQLite transaction would contradict point 17's own principle of not running author code during a transaction. The scheduler already has a synchronous pre-reconcile `Effect.try` for `validatePolicies` (`scheduler.ts:~20–31`), outside the transaction. See A2.
- [inference] Point 18 says an invalid unchanged schedule value "prevents that schedule's application from loading". In practice `WorkflowSchedule.make` throws `DefinitionError` while the module is evaluated, so the whole application revision fails to load, not one schedule. This is the existing behavior for an invalid schedule `input`, so it is consistent. The wording should still say so explicitly. See A2.

### Describe / plan JSON Schema (points 19–20)

- [probe] Point 20's claim holds: `Schema.toJsonSchemaDocument(composedCodec)` gives `{ type: "string" }` for literals, Int, Boolean and every other case I tried.
- [probe] `Schema.toJsonSchemaDocument(Schema.toType(composedCodec))` produced these results:
  - `Literals` gives `enum ["dev","prod"]`.
  - `Int ≥ 0` gives `integer, minimum 0, maximum MAX_SAFE`.
  - `Boolean` gives `boolean`.
  - `NonEmptyString` gives `minLength 1`.
  - `fromJsonString(Struct)` gives the object schema.
  - `BigInt` gives a string with a digits pattern.
- [probe] The output is identical to `toJsonSchemaDocument(Schema.toCodecJson(Schema.toType(S)))` for every case. So "canonical JSON representation of the decoded value" is literally Effect's JSON codec of the Type side. This is a correct description, and the conversion works from the stored `definition.codec` alone, with no need to keep `S`.
- [probe] Some outputs are best-effort and worth documenting:
  - `UndefinedOr(String)` renders as `anyOf [string, null]`, and `NullOr(String)` likewise shows `null`, even though the key is still required and the wire carries strings.
  - Brands are invisible.
  - `Date` shows a plain `string`.
  - `NumberFromString` shows `number | "Infinity" | "-Infinity" | "NaN"`.
  - Custom `makeFilter` checks disappear, which point 20 already says.
- [source] Existing `describe` (`control-plane.ts:104–127`) projects `input`/`success`/`error` with `toJsonSchemaDocument(schema)`, which is the encoded/wire side, inside `boundary(() => json(…))`. A conversion failure therefore already fails the whole describe call. This is the "existing error behavior" that point 20 preserves. `WorkflowPlan` currently returns no schema documents, and its RPC success type is `Schema.Json`, so adding `tagSchemas` there has no wire-compatibility cost. It is redundant with describe but harmless.
- The deliberate mismatch is coherent and disclosed: `input` documents the wire side, while `tagSchemas` documents the decoded side because the wire side is always a string.

## Required corrections

- **A1. Classify sync-boundary failures with Effect, and name the code.** Points 14 and 15 change as follows:
  - Binding encode/round-trip, schedule override decoding and manual admission use `Schema.encodeUnknownExit`/`Schema.decodeUnknownExit` with the composed codec. Also allowed is any helper built on them that keeps the `Cause`.
  - A `Fail` (`SchemaError`) is an invalid value. It maps to `DefinitionError` at construction, or to `OperationError`/`InvalidInput` at admission, with the key and the bounded issue message.
  - A `Die` (`AsyncFiberError`) is the synchronous-boundary violation. Do not sniff Effect's message text or catch everything thrown by `*Sync`.
  - The contract must state the code used when an async codec on a bare declaration is first detected at manual admission. I recommend `InvalidInput` with a message that names the tag and says the **workflow declaration** must decode synchronously, so the operator is not told their value is wrong. This avoids adding a wire code.
  - Tag admission errors must not go through the existing input/policy `Effect.try` catch, which discards the message.
- **A2. Placement of reconcile validation and wording for load failure.** Point 17 must say where the revalidation runs. Either (a) it runs in the scheduler's existing pre-reconcile synchronous `Effect.try` beside `validatePolicies`, never inside the `reconcile` SQLite transaction. Or (b) it is dropped as redundant, citing `WorkflowSchedule.make`'s validation plus `Application`'s canonical-workflow identity check, which together guarantee that the schedule was validated against that revision's registered root. I prefer (a) as cheap defense-in-depth. Point 18 should say "the application revision fails to load (the existing invalid-schedule path)" rather than implying a per-schedule failure.
- **A3. Exact describe expression and caveats.** Point 19 should name the expression as `Schema.toJsonSchemaDocument(Schema.toType(definition.codec))`. This was verified equivalent to the JSON codec of the Type side, and no source schema needs to be retained. The public documentation should list the probed caveats: `NullOr`/`UndefinedOr` render a `null` alternative although the key stays required, brands and custom filters are invisible, `Date` is a plain string, and `NumberFromString` includes the non-finite string literals. Requiredness is expressed by the set of keys in `tagSchemas`, not by the inner documents.

## Not required (author's discretion)

- Compile-time checking that a schedule supplies every required bare declaration. It would need `Workflow.Spec` to carry a typed declaration tuple into `WorkflowSchedule.make`. The runtime `DefinitionError` at module load is consistent with existing schedule-input validation. Add the type-level check later only if users ask for it.
- `tagSchemas` in `workflow plan`. Plan has no other schema documents, so describe alone would be enough. Keeping it is harmless.
- A typed `tagSchemas` map on `Workflow.Definition`. Per-key erasure is fine.

## Material decisions versus small fixes

- **Material, already approved by the user:** required bare declarations, defaults only through bindings, no optional-declaration DSL, workflow-scoped early validation, and the codec captured by the root being authoritative. None needs to go back to the user. The optional-metadata limitation in point 4 should still be visible in the presentation.
- **Material, new in this document, which I consider in-direction and not needing another permission cycle:** describe projects decoded-side JSON Schema rather than the wire side (point 20), and binding provenance supersedes the old "no codec references in bindings" rule (point 9). Both follow directly from the approved Option B, as the typed draft anticipated.
- **Small fixes:** A1–A3 above.

## Proofs to add to the focused verification list

- An async codec on a bare declaration: manual admission returns the A1 code and message, `WorkflowSchedule.make` throws `DefinitionError` with the sync-restriction text, and a direct `context.readTags` read still succeeds. This last check shows that the restriction is limited to boundaries.
- A tag-only schedule edit is reconciled without author code running inside the reconcile transaction, as chosen in A2.
- A describe snapshot includes at least one `NullOr` declaration, which documents the caveat in A3.

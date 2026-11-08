# Run tag admission — consumer review, round 1

Reviewer: Claude, consumer-DX review subagent. Subject: [run-tags-admission-contract.md](run-tags-admission-contract.md), revision 1, read against [run-tags-typed-api-draft.md](run-tags-typed-api-draft.md) (revision 3) and [the prior consumer review](run-tags-typed-review-consumer-round1.md). Scope: only the new admission details and whether they are consistent with what the user approved. I did not re-review the settled baseline. No production edits, no commits, no subagents. Reviewer approval is not user approval.

## Verdict

**Approve with one material decision to put back to the user, plus small fixes.** The contract is coherent and implementable, and it closes the gaps that round 1 asked to close: early failure before side effects, schedule-time validation, captured declarations and describe output. One rule goes beyond the direction the user approved and changes the stated character of tags. That rule needs an explicit yes (M1). The rest are documentation and error-shape fixes inside the approved direction (F1–F8) and need no new permission cycle.

## Evidence

All probes ran with bun against pinned `node_modules/effect` 4.0.5. Each probe was a temporary file that I deleted afterwards. Nothing was committed.

- The declared codec is `Schema.String.pipe(Schema.decodeTo(Schema.toCodecStringTree(s)))`. For that codec, `Schema.toJsonSchemaDocument(codec)` gives `{"type":"string"}` for env, shard, dry-run and Date, which confirms point 20. `toJsonSchemaDocument(Schema.toType(codec))` gives:
  - env: `{"type":"string","enum":["dev","prod"]}`
  - shard: `{"type":"integer","minimum":0,"maximum":9007199254740991}`
  - dry-run: `{"type":"boolean"}`
  - Date: `{"type":"string"}`, with no format, which is weaker than one might expect.
- The inner `toCodecStringTree(s)` encoded doc does carry wire hints: boolean is `{"type":"string","enum":["true","false"]}`, and a number is a numeric-string `pattern`. See F6.
- `toCodecStringTree(Schema.Boolean)` rejects `""` with `Expected "true" | "false"`. `Config.schema(Int).pipe(Config.withDefault(0))` parsed against `{ shard: "" }` with `preserveEmptyStrings: true` fails. It does not fall back to the default. This confirms point 5: an empty string is present and invalid.
- `NullOr(String)` type doc is `anyOf [null, string]`, while its wire form is the string `"null"` or any string. That is a discoverability edge case; see F6.
- CLI: `OperationError` `InvalidInput` maps to exit code 2 (packages/cli/src/main.ts:1221). So the missing and invalid examples in the contract exit 2 with no run ID, which is the behaviour consumers want.

## Material decision (needs explicit user choice)

### M1 — A bare declaration makes the tag a required run input (points 1–4)

The user approved workflow-scoped declarations with early validation. The approved Option B text and the typed draft left optionality open on purpose. Revision 3 said: "must specify optionality of bare declarations, whether a bound default makes a key required … these are further API decisions, not internal details." The contract now decides all of the following:

- A bare definition is **required** on every root run, with no optional-declaration syntax.
- A binding is declared, defaulted and therefore always present.
- Optional typed metadata cannot be declared at all. The only way to keep it optional is to leave the key undeclared, which means no early validation.

That choice matters for three reasons:

1. **It reverses a stated design intent.** The typed draft says, "Tags remain metadata: required business inputs belong in a task/workflow input schema." Under M1, `tags: [Shard]` _is_ a required run input, sitting next to `--input`. That may be the right call. Shard is effectively an input in the example. But it is a change of stance, not a detail.
2. **It contradicts the example the user saw.** The approved Option B sketch is `tags: [Environment("dev"), Shard, Label]`. The reader sketch next to it uses `Label.config.pipe(Config.option)` and `Shard.config.pipe(Config.withDefault(0))`. Under the contract, `Label` must be supplied on every manual run and every schedule, and both reader fallbacks become dead code on that root (point 3). A user who approved that sketch probably read `Label` as "validated if present".
3. **Adding a bare declaration is a breaking change.** Every existing schedule without an override fails `WorkflowSchedule.make`, so the application fails to load (point 18). Every script that calls `workflow run` without the key starts exiting 2. The contract does not say this.

Options to present, as one short question:

- **(a) Keep the contract (recommended).** Bare means required, and there is no optional declaration in this slice. This is the only option that also catches a _missing_ tag before side effects. It matches the required read in `Config`, and it keeps one simple rule. Accept it explicitly as "declared tags are required run parameters". Update the sketch to use `[Environment("dev"), Shard]` and drop `Label` from the declarations.
- **(b) Bare means validated if present, optional at admission.** Missing tags then fail late, at read time, which is the Option A failure mode for absence. Garbage values still fail early.
- (c) An explicit optional marker. This is new API surface, so I do not recommend it for this slice.

The rest of the contract follows the same direction the user approved, and I do not consider it material:

- Captured codecs and binding provenance (points 9–10)
- The root codec winning for schedule overrides (point 11)
- Errors before admission (points 12–14)
- Schema edits blocking load (point 18)
- Type-side JSON Schema (points 19–20)

## Small fixes (within the accepted direction)

**F1 — Report every declared-tag problem in one error (point 14).** "Naming the key" reads as fail-fast, mirroring `Config.all`. At submission, the host already iterates every declaration. Collect all missing and invalid declared keys into one bounded `InvalidInput` message, for example `missing required tag "shard"; tag "env": Expected "dev" | "prod", got "garbage"`. That avoids one exit-2 round trip per tag. Apply the same rule to the `DefinitionError` from `WorkflowSchedule.make`. Keep the existing message cap, and truncate with a count, such as "+3 more".

**F2 — Make the missing-tag message actionable.** The message should name the fix, not just the fact: `required tag "shard" is missing; pass --tag shard=<value> (see: effectory workflow describe report)`. For a schedule, it should name the schedule and suggest an override.

**F3 — State the breaking-change rule in user docs.** Adding a bare declaration, tightening a codec, or removing a binding default can break existing schedules at load time and existing callers at submission. To add a tag without breaking anything, add it as a binding with a default. Point 18 should also say plainly how far a failure reaches. Today it says "prevents that schedule's application from loading/activating". Spell out whether the whole application revision is rejected, which is what a throwing `WorkflowSchedule.make` implies, and what keeps running in the meantime. Use the existing activation-failure semantics, and add no new state.

**F4 — Make required tags visible in describe without inference (point 19).** As written, a consumer must compute required tags as `keys(tagSchemas) − keys(tags)`. Keep the JSON shape unchanged. The human-readable `workflow describe` output should list each declared key as `shard (required)` or `env (default "dev")`. If the JSON may change, an optional `requiredTags: string[]` (sorted) is derived data, not a new concept. Prefer the text-only change if the shape is frozen.

**F5 — Name the default form (points 2 and 19).** `tags` in describe holds _encoded_ defaults (`"false"`), while `tagSchemas` describes the _decoded_ type (`boolean`). One sentence in the CLI docs should say that values on the command line are the encoded strings: booleans are `true`/`false`, numbers are decimal, literals are their own text. Also note that the `tags` default values have that wire form.

**F6 — Spell out the limits of discoverability.** The probes back point 20's choice of type-side schemas: they are much more useful than the declared-codec doc. Add two caveats to the docs:

- The type-side document can misdescribe the wire form. `NullOr(String)` shows `null`, which the CLI cannot send as JSON null. Date shows a bare `string`.
- Declaring a tag through a nullable, union or structured schema is legal, but neither tool output nor docs will explain its wire format well.

Recommend scalar schemas for tags: literals, strings, integers, booleans and brands of them. Do not add a second wire-schema field in this slice. If one is wanted later, `toJsonSchemaDocument(toCodecStringTree(s))` already yields wire enums and patterns, so no homemade inspection is needed.

**F7 — Spell out how reader defaults interact with declarations (point 3).** Once a root declares a key, `Config.withDefault` and `Config.option` on that key are unreachable under that root. They only matter for direct `task run`, `Task.test`, or a root that does not declare the key. Update the revision-3 sketch so it does not show `Shard` declared bare _and_ read with `withDefault(0)`. That combination is what a consumer will copy. One line suffices: "the workflow default is the default; a reader default is a fallback for un-declaring roots."

**F8 — Document linked children and direct task runs as known limitations (point 11).** The contract explicitly says a linked child's declarations are ignored under a host root. As a result, a child declaring `[Shard]` used under a root that omits it fails at read time, mid-run, after earlier side effects. That is acceptable for this slice. The docs, though, should say: "If a linked child declares tags, declare the same keys on every root that links it." Also add a test that exercises this late failure, so the behaviour is pinned and not accidental. Do not add cross-child validation now. Merging codecs across roots and children reopens the "one codec per key" question and is a separate design. Direct `task run` receives generic `RunTags` validation only, so say in the CLI help or docs that typed tag validation applies to `workflow run` and schedules only.

## Points checked and fine as written

- Point 5: empty string is present. The probe confirms that `--tag dry-run=` fails even with a reader default, with no trimming. This is clear and consistent.
- Points 6–8: `Tag.Declarations` is a separate authoring type, so bare definitions cannot leak into schedules, fixtures or publications. Duplicates are rejected, including `[Shard, Shard(3)]`, and the 32-declaration count includes bare entries. These are good consumer guardrails.
- Point 7: a raw-map-only workflow gets no declarations. This is an honest escape hatch, and dynamic labels and unknown keys still work. Suggestion: the docs should note that `tags: { env: "dev" }` gives no validation even if an `Environment` tag exists elsewhere.
- Point 11: the root codec is authoritative for schedule overrides built from a different definition with the same key. This is the right choice, and it is already in the verification list.
- Points 12–13: receipt lookup happens before defaults and declarations, the fingerprint uses caller tags, and stored strings are preserved (`03`). These are consistent with the baseline, and retries stay stable across schema edits.
- Points 16–18: tag and schema edits leave schedule identity unchanged and preserve catch-up. An invalid edit blocks load instead of silently admitting values. Admitted runs keep their recorded strings. This is the expected behaviour; only the wording in F3 needs work.
- Point 21: no tag dry-run in `validate`/`plan`. This is acceptable because submission itself fails before admission with exit 2 and no side effects. Mention it as a known gap, not a promise.
- Point 15: synchronous-only validation with an explicit error for suspended codecs. From the consumer side, the error must name the tag and say "codec must be synchronous". The contract already requires that.

## Summary for the presenter

- **Ask the user (M1):** "Declared tags without a default become required run parameters, and there is no optional declared tag in this slice. Optional typed metadata stays undeclared and is validated only at read time. OK?" Recommend yes. Show the corrected sketch without bare `Label`.
- **Apply without another review cycle:** F1–F8. All are wording, message or test changes, with at most one optional derived describe field (F4).
- **No new API family is needed.**

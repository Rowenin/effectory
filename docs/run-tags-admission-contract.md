# Run tag admission — revision 2, requiredness decision pending

SUPERSEDED: The user explicitly chose optional bare declarations. [The approved final contract](run-tags-contract.md) incorporates that choice and the final Effect corrections. Requiredness and requiredTags passages below are historical proposals, not implementation requirements.

The consumer review identified bare-declaration requiredness as a material choice left open in the user's approval. The question is now pending with the user. The required-tag rules below describe the recommended option, not permission to implement it. Independent consumer fixes F1–F8 have been applied. The Effect review is still pending.

The user approved the typed Tag/Config design and workflow-scoped declarations with early validation: "yes lgtm". This document completes the previously explicit open points before implementation. It supersedes Option A and the unresolved Option B details in [the typed proposal](run-tags-typed-api-draft.md). The baseline [run-tag persistence and query contract](run-tags-api-draft.md) otherwise holds. No production code has been written for tags.

Both Claude perspectives must review these remaining public semantics. They are not being asked to re-review already settled persistence/filtering decisions. A material redesign still returns to the user; routine fixes within the accepted direction do not need another permission cycle.

The SDK package was renamed by the concurrent workspace session to `@offtree/effectory-sdk`. New examples and exports use its current name; older proposal references to @effectory/core mean this same core package, not another package to introduce.

## Consumer contract

```ts
// PROPOSED, not implemented/typechecked as an actual API.
import { Tag } from "@offtree/effectory-sdk";
import { Config, Schema } from "effect";

const Environment = Tag.make("env", Schema.Literals(["dev", "prod"]));
const Shard = Tag.make(
  "shard",
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
);
const DryRun = Tag.make("dry-run", Schema.Boolean);

// A root Workflow.make spec:
// tags: [Environment("dev"), Shard, DryRun(false)]
// env and dry-run have defaults. shard must be supplied by the caller/schedule.

const ReadTags = Config.all({
  environment: Environment.config,
  shard: Shard.config,
  dryRun: DryRun.config,
});
// In an Effect.gen task handler:
// const tags = yield* context.readTags(ReadTags);
```

```sh
# Defaults env=dev and dry-run=false, explicit shard=3:
effectory workflow run report --input null --tag shard=3
# InvalidInput before a run is admitted; no task executes:
effectory workflow run report --input null
effectory workflow run report --input null --tag shard=oops
effectory workflow run report --input null --tag shard=3 --tag env=garbage
```

## Presence and defaults

1. Every declared key is required in the effective root-run map. A binding declares a key and gives it an encoded default. A bare definition declares a key with no default, requiring a submission override or schedule override. This matches Config's required read and makes missing declared tags fail before side effects.
2. The workflow's own construction does not require a value for a bare definition: it validates each supplied default but permits a declaration without a default. Manual submission first merges root defaults with caller overrides, then requires all declared keys and decodes each present encoded string against its declared codec. Schedule construction merges root defaults with schedule overrides and performs the same presence/domain checks synchronously.
3. A reader's Config.withDefault is not a workflow default and cannot satisfy a required workflow declaration. Its absence fallback never takes effect under a root declaring that key: admission/default merging already ensures presence. It remains useful for direct task runs, Task.test or tasks reused under roots that do not declare that key. Config.option likewise never returns None for an ordinarily decoded missing key under that root and does not change the root's contract. Requiredness belongs to the declaration, not the handler's selected Config program.
4. A nullable/undefined-admitting value schema does not make the key optional. Presence is checked with an own-property check before decoding. All stored values are strings. There is no optional-declaration syntax in this slice. For optional metadata, leave the key undeclared on the root and use the shared Tag definition with Config.option/withDefault at read time; present values for such undeclared keys receive generic RunTags validation only. Business-critical optional typed input belongs in the existing input schema. This limitation is explicit.
5. An empty string is present and must pass the codec. Thus an empty String tag is valid; `--tag dry-run=` fails even with a reader default. No trimming, canonicalization, environment fallback or implicit reader defaults are used during admission.

## Captured definitions and authoring inputs

6. Tag.Input remains binding-array-or-raw-map for schedules, fixtures and publications. Only Workflow.Spec.tags additionally permits bare Tag.Definition values in its array. Expose this distinct authoring type as `Tag.Declarations`: `ReadonlyArray<Tag.Definition | Tag.Binding> | Readonly<Record<string, string>>`, with the implementation's existential generic aliases preserving heterogeneous definitions without widening individual callable parameter types. An array cannot mix a raw object/pair into its entries.
7. A raw-map-only Workflow.Spec.tags supplies untyped defaults, with no inferred declarations. This preserves dynamic labels. A typed binding in a workflow declares its own source codec; a bare definition supplies the same codec without a default. Unknown submission keys remain legal generic metadata. A declaration does not globally claim its key.
8. Duplicate keys in one workflow array fail DefinitionError, including `[Shard, Shard(3)]`, repeated references, and different definitions with the same key. One binding already declares its key, so no second declaration is needed. At most 32 distinct declared keys and 32 keys in each effective run map; required bare declarations count toward the declaration limit even before values are supplied. Other binding arrays continue to reject duplicate keys. Cross-layer overrides are intentional and not duplicates.
9. Bindings retain their snapshotted encoded key/value plus internal source-definition provenance. This supersedes the old rule forbidding codec references in bindings. The public binding remains opaque; no domain object is retained. All accepted array members have runtime provenance checks, not merely TypeScript brands. Workflow normalization reads the captured source definition, creates its own frozen maps, and serializes no functions or schemas.
10. Workflow.Definition exposes required readonly `tags: Readonly<Record<string, string>>` (encoded defaults) and `tagSchemas: Readonly<Record<string, Schema.Codec<unknown, string, never, never>>>` (declared codecs). Both are frozen snapshots and always present, including empty maps. The host reads these fields, not mutable spec.tags. Tag.Definition itself still has key/codec/config and the typed callable. WorkflowSchedule.Definition.tags remains the encoded override map; its workflow reference supplies declarations. No second schedule declaration mechanism or Task.Spec tags field is added.
11. Schedule overrides may use a separately constructed tag with the same key. The workflow's captured codec is authoritative at admission: the encoded override must pass it, regardless of the codec that produced the override. Linked child workflow declarations/defaults do not add constraints or overlays to the host run. Children share the root's immutable map; their typed reads can still fail if they require metadata the root did not declare, after earlier tasks have produced side effects. Declare a linked child's needed keys on every submitting root to get early validation. Standalone submission of that child validates its declarations normally. Direct task submissions receive generic RunTags validation only; CLI documentation explicitly limits declaration validation to workflow submissions and schedules.

## Admission and errors

12. Manual workflow admission order is: generic wire validation; the existing receipt lookup using the caller's encoded map; resolve the selected revision and root workflow; merge defaults/overrides; enforce effective RunTags limits; require declared keys and decode their strings; validate existing input/policy; atomically admit the fully resolved map with the existing second receipt check. Exact ordering of tag versus input checks is internal, but both precede admission. A retry with an existing receipt returns that original receipt before loading new defaults or declarations. The manual fingerprint remains based on caller-supplied tags, not merged defaults or schema identities.
13. Domain validation uses the same service-free codec as the Tag reader, through Effect Schema. It validates only: preserve the submitted string even when the decoded value would re-encode differently. `shard=03` therefore reads as number 3 but remains `03` in storage, fingerprints and exact-match filters. Binding creation still requires semantic round-trip equivalence; raw values have no original decoded value to compare. Unknown keys and raw maps are not stripped.
14. Manual missing/invalid declared tags fail OperationError/InvalidInput. Collect problems across all declarations in one bounded message (maximum 2048 characters), using Effect Schema decoding with its all-errors option within a key when appropriate. Include each key and its issue, truncate with a count of omitted key problems, and keep deterministic key order. A missing key includes an actionable hint: `required tag "shard" is missing; pass --tag shard=<value> (see: effectory workflow describe report)`. Generic wire/total-budget errors remain their existing boundary checks, outside this declaration-error aggregation. No run ID or receipt is created. Invalid default bindings and bad/duplicate workflow declarations fail DefinitionError at construction. A schedule missing a required key or containing an invalid override fails DefinitionError during WorkflowSchedule.make; collect its declaration problems similarly, name the schedule, and suggest adding/correcting its tag overrides. Task.test retains the ability to supply invalid domain-specific raw strings to exercise read failure; it does not simulate workflow admission. Runtime Config.all keeps its normal fail-fast behavior.
15. Authoring binding/default/schedule validation must be synchronous and service-free, like existing boundaries. Async transformations cannot be supported in those declarations merely because they type as service-free. Detect an attempted suspended encode/decode and produce an explicit error naming the tag and the synchronous boundary restriction. Admission checks use the same synchronous boundary restriction, preventing a codec accepted in one mode but silently skipped in another. Typed task reads remain normal Effects. Custom codecs/refinements must be deterministic and side-effect-free; the system cannot prove that property from Schema types.

## Schedules, revisions and durability

16. Tag values and declaration/schema changes are excluded from the schedule occurrence identity hash. Changes update the observed revision/configuration, preserving generation, watermark and any unadmitted pending slot. A workflow version bump retains its existing generational effect. No function/AST hash or JSON Schema hash is used as schema identity.
17. WorkflowSchedule.make validates the effective tags against its referenced workflow. Reconciliation validates the captured effective map using the observed revision's definitions before storing it with that revision. The SQLite occurrence transaction can use this already-validated stored configuration; it does not need to load author code inside the transaction. It still strictly checks stored RunTags shape/limits when loading. Codecs are not persisted. The existing accepting fence and run-plus-pending-slot atomic commit remain intact.
18. A schema edit invalidating an unchanged schedule value rejects the entire application revision through the existing definition validation path, not only that schedule. Adding a bare required declaration, tightening a codec, or removing a binding default can break schedules at load time and callers at submission. Adding a valid binding default avoids missing-key breakage, though callers explicitly overriding it must still pass its codec. During candidate preparation in a running daemon, a rejected candidate does not change the active revision; that daemon continues serving/running its prior active revision. At cold start, invalid source prevents daemon startup; there is no automatic fallback to the retained active revision. Source edits alone do not trigger live reload. Direct construction shows DefinitionError; the existing dynamic import/catalog path can wrap it as RevisionUnavailable. Preserve that error contract and do not promise a new per-schedule activation state. A successful tag/schema-only edit preserves catch-up. Already admitted runs keep their recorded strings and pinned code; no new schema is applied retroactively. A pending unadmitted occurrence uses the newly reconciled valid definition/revision when finally admitted, as already specified for tag-only edits. Existing scheduler error/status surfaces report reconciliation failures; no new schedule state is added.

## Discoverability

19. Workflow describe and workflow plan expose `tags` as the captured encoded defaults and `tagSchemas` as a JSON object keyed by each declared key. Each value is a JSON Schema document generated with `Schema.toJsonSchemaDocument(Schema.toType(declaredCodec))`. It describes the canonical JSON representation of the decoded tag value, not the CLI wire value. Thus env shows its literals and shard shows integer/nonnegative constraints, while the CLI still accepts strings. All keys in tagSchemas are required after default merging. Add a sorted `requiredTags: readonly string[]` to those outputs containing declared keys without a default, making caller obligations explicit in the existing JSON-style describe output. This is derived from keys(tagSchemas) minus keys(tags); it is not a separately configurable declaration. Task descriptions have neither workflow declarations nor workflow defaults. CLI documentation says defaults and command-line values use encoded strings: e.g. "false" on the wire versus boolean in tagSchemas. Prefer the encoder's ordinary decimal spelling for numbers; raw alternate numeric spellings such as 03 retain their exact-string semantics.
20. This is a deliberate correction to the earlier suggested conversion: a scratch probe of `Schema.toJsonSchemaDocument(declaredCodec)` produces only `{ type: "string" }` even for literals and integers, hiding the useful information. JSON Schema remains descriptive/best-effort: custom refinements and some domain types cannot be fully represented. NullOr(String) shows a JSON null alternative even though the CLI must send text "null"; Date's type-side document may be a string with no format. These documents do not fully explain such wire conversions. Recommend literal, string, integer and boolean schemas, or brands of those, for tags. Nullable, union and structured codecs remain legal within the string/round-trip/budget rules but need explicit author documentation of their wire format. No second wire-schema field or homemade AST inspection/validator is added. The actual Effect decoder is authoritative. Preserve existing describe error behavior if conversion itself fails.
21. Schedule get continues to expose only effective encoded tags, plus its existing workflow identity/revision; consumers use workflow describe at that revision for the declarations. Run replies remain encoded maps. No new validation RPC, flags or capability beyond run-tags.v1 is added. Existing workflow validate/plan input validation does not accept per-run tags in this slice; descriptions/plans show declarations but do not validate a hypothetical tag override.

## Focused verification

- Typecheck heterogeneous arrays, wrong callable inputs, bare definitions allowed only on workflows, captured codec map and immutable metadata. Prove runtime provenance/duplicates/32 declarations without treating an ordinary function as a valid bare definition.
- Default+required manual acceptance, missing declared values, bad literals/integers/empty booleans, nullable/undefined-admitting declaration still requiring presence, unknown dynamic keys, raw-map-only workflow defaults, and no execution/receipt on rejection. Multiple bad/missing declarations yield one actionable bounded error with an omitted-problem count when truncated.
- A schedule satisfies a required declaration through overrides, rejects missing/invalid overrides, and checks a different definition's encoded value against the root's codec.
- Existing receipt returns after defaults/schema edits without revalidation. Tag/schema-only valid edits preserve pending catch-up/generation; invalid edits surface load failure; admitted runs keep original strings/readers.
- Confirm describe documents contain env enum and shard integer/minimum while output maps remain strings; requiredTags explicitly lists unde­faulted declarations in sorted order. Confirm custom checks/wire encodings are not promised by decoded JSON Schema. Test both describe and plan projections.
- Pin the known late-failure path for a linked child whose declarations were omitted by its root, and show that direct task submissions receive no workflow-level typed validation.
- Config reads in real Task.make/Task.test have the same mapped error path, preserve empty strings, and ignore a conflicting daemon environment variable. Dynamic binding errors use the documented Effect.try pattern.
- Existing baseline storage/index/filter/compatibility and end-to-end CLI proofs remain required. Required checks are `bun run typecheck && bun run check && bun test`; isolate verification sources if the concurrent SDK/package-rename session is still editing.

## Consumer round-1 resolution

M1 (required bare declarations, without optional declared tags) is awaiting explicit user choice. The wording and examples are provisional on that choice. F1–F8 are applied: aggregated/actionable errors, breaking-change and whole-revision failure semantics, explicit requiredTags output, encoded defaults versus decoded descriptions, scalar-schema guidance, reader-default limitations and linked-child/direct-task coverage. The reviewer requires no further consumer round for those corrections. No source implementation has started.

# Typed run tags — revision 3, DIRECTION APPROVED

[The final approved contract](run-tags-contract.md) selects optional bare declarations and resolves the remaining review corrections. It supersedes conflicting passages in this draft.

The user approved workflow-scoped declarations and early validation. [The final admission contract](run-tags-admission-contract.md) selects Option B and defines its remaining required/default, captured-schema and scheduling semantics. Those details are receiving the promised focused Claude review before implementation. That document supersedes the open-choice passages below.

Proposal only. The user requested `Tag.make("label", Schema.… )` and `tags: [LabelTag(value)]`, with heavy reuse of Effect primitives. Both Claude reviews conditionally cleared presentation after the corrections recorded below, now applied. The admission-validation choice remains open. No user approval or production implementation is authorized. Examples involving Tag are proposed and have not been typechecked against a real implementation.

This document replaces the authoring portions of [the string-map proposal](run-tags-api-draft.md). Its durable storage, indexed filtering, merge precedence, schedule identity, budgets, client compatibility and immutable receipt decisions remain in force. The earlier Claude approvals apply to that baseline, not this new API.

## Design intent

A tag definition associates a literal metadata key with an Effect Schema. Calling it validates and encodes a typed value into one immutable string binding. Reading uses real Effect Config values, an explicit ConfigProvider backed by the stored map, and standard Config/Effect composition. No environment lookup is needed. No new parser, default/optional combinators, service, Layer, schema DSL or globally registered tag catalog is introduced.

The codecs and Config primitives are real Effect values; only associating a key with a callable binding constructor is Effectory-specific. Tags remain metadata: required business inputs belong in a task/workflow input schema. The distinction between typed authored bindings and unrestricted CLI strings is explicit below.

## Consumer sketch

```ts
// PROPOSED; Tag does not exist yet.
import { Tag } from "@effectory/core";
import { Config, Schema } from "effect";

export const Label = Tag.make("label", Schema.NonEmptyString);
export const Environment = Tag.make("env", Schema.Literals(["dev", "prod"]));
export const Shard = Tag.make(
  "shard",
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
);
export const DryRun = Tag.make("dry-run", Schema.Boolean);

// Workflow.make spec:
// tags: [Label("billing"), Environment("dev"), Shard(3), DryRun(false)]
// WorkflowSchedule.make spec override:
// tags: [Environment("prod")]
// Task.test options:
// tags: [Environment("prod"), Shard(2)]
// context.publish options:
// tags: [Label("summary")]

// Compile-time errors: Shard("3"), Environment("production"), DryRun("false").
// Runtime validation: Shard(-1), Label("") throw DefinitionError.

// Each .config is an actual Config.Config<A>, with normal Effect combinators.
export const ReportLabels = Config.all({
  environment: Environment.config,
  shard: Shard.config.pipe(Config.withDefault(0)),
  dryRun: DryRun.config.pipe(Config.withDefault(false)),
  label: Label.config.pipe(Config.option),
});

// In an Effect task handler:
// const labels = yield* context.readTags(ReportLabels);
// labels: { environment: "dev" | "prod"; shard: number;
//           dryRun: boolean; label: Option.Option<string> }
```

`context.readTags(config)` accepts any real Effect Config, parses it against the run's frozen tag map, and maps ConfigError to the existing TaskRuntimeError / InvalidBoundary, with a bounded message retaining the key and Schema issue. It works in a handler whose declared error is Schema.Never without repetitive error mapping. The provider is created once per context using ConfigProvider.fromUnknown with preserveEmptyStrings:true. Task.test uses the same context construction.

Outside a task, or when the caller wants Effect's ConfigError directly, the explicit escape hatch is:

```ts
// PROPOSED; assumes ReportLabels and Tag above.
const readLabels = (tags: Readonly<Record<string, string>>) =>
  ReportLabels.parse(Tag.provider(tags));
// Effect<decoded labels, Config.ConfigError>
```

Do not yield `Environment.config` directly to read run tags. Because it is a real Config, direct yielding uses Effect's ambient ConfigProvider, which defaults to the daemon's environment. This can silently return an environment variable with the same name. `.config` JSDoc must state this. Use context.readTags inside handlers or explicit parse(provider) elsewhere. The host does not replace the ambient provider: ordinary Config reads for application settings must retain their meaning. A binding is not itself an Effect or Config.

Config.withDefault and Config.option handle absence, not an invalid present value. Prefer workflow defaults for normal runs; reader defaults cover direct task runs and reuse under workflows without that default. These are separate defaults and can drift. Config.all fails fast on the first bad tag; this API does not add error aggregation.

Branded schemas retain Effect's normal construction requirements:

```ts
// PROPOSED; actual Schema API, proposed Tag API.
const TeamId = Schema.NonEmptyString.pipe(Schema.brand("TeamId"));
const Team = Tag.make("team", TeamId);
const teamBinding = Team(TeamId.make("platform"));
// Team("platform") is a type error: the value must carry the brand.
```

Binding calls validate synchronously, like other authored definitions. When constructing a binding from a dynamic value inside a task, use Effect.try so invalid values become typed failures rather than defects:

```ts
// PROPOSED helper; Label and TaskRuntimeError imported/defined as above.
const bindLabel = (value: string) =>
  Effect.try({
    try: () => Label(value),
    catch: (error) =>
      new TaskRuntimeError({
        code: "InvalidBoundary",
        message: `Invalid publication label: ${String(error).slice(0, 512)}`,
      }),
  });
// Inside Effect.gen:
// const label = yield* bindLabel(dynamicValue);
// yield* context.publish("summary", payload, { key: "summary", tags: [label] });
```

Effect and TaskRuntimeError must be imported for that helper. Directly calling Label(dynamicValue) inside Effect.gen can throw a defect before publish is called. The library cannot catch argument-evaluation failures from inside publish. This limitation must be included in the public documentation, not just this design note.

```sh
# Values on the CLI and RPC are still strings.
effectory workflow run report --input null --tag env=prod --tag shard=3 --background
effectory run list --tag shard=3 --json
```

## Public contracts to review

1. Export the `Tag` namespace from the core root and `@effectory/core/Tag` subpath, matching Task/Workflow namespace conventions. It has `make` and `provider`, plus the Definition, Binding and Input types. Keep RunTags as the schema-only wire map from the baseline; protocols do not import Tag's authoring module.
2. `Tag.make<const Key extends string, S extends Boundary>(key: Key, schema: S)` returns a frozen callable `Tag.Definition<Key, S>`. Boundary is the existing service-free core codec constraint. The call accepts `S["Type"]` and produces a frozen opaque `Tag.Binding<Key>`. S is fixed by make's schema argument, so a subsequent call cannot widen it; NoInfer on the callable parameter would add no protection. Binding stores only validated key and encoded string, not a reference to a caller-owned domain value or codec under Option A. Only make-created bindings are valid array members; no tuple/object structural forgery API. Enforce this at runtime at every array-input boundary using module-private provenance, not only a TypeScript brand.
3. Definition exposes readonly `key: Key`, `codec: Schema.Codec<S["Type"], string, never, never>` and `config: Config.Config<S["Type"]>`. The codec is derived with `Schema.String.pipe(Schema.decodeTo(Schema.toCodecStringTree(schema)))`; config uses `Config.schema(codec, [key])`. The single-element path treats dots and slashes as literal key characters. It does not split `deployment.region` into a nested lookup.
4. The codec uses Effect's canonical StringTree conversions. Schema.Int/Boolean/literals/brands/refinements work directly; existing string codecs work too. One tag must encode to one string. Plain Struct/Array values cannot be bound; users can explicitly choose `Schema.fromJsonString(...)` for a structured value encoded as one string, subject to the same small value limit. The string composition enforces this via Schema rather than a bespoke AST walker. Unsupported schema shapes may construct a definition and fail when bound/read; the composed codec also permits Config.schema construction for Unknown/MutableJson. No construction-time schema-support detection is promised.
5. `Tag.make` validates the key synchronously. Calling a definition synchronously encodes, checks scalar string/value limits, decodes back, and requires equality with the original under `Schema.toEquivalence(schema)`. Merely decoding successfully is insufficient: NullOr(String) can turn string "null" into null, and Union([Int, String]) can turn string "3" into number 3. Reject these lossy bindings. Errors become existing DefinitionError with a bounded message identifying the key and cause. No lossy String(value) fallback. The binding snapshots encoded bytes immediately. Constructors/fixtures still validate the full merged map and its total budget. As with existing authored boundary encoding, schemas used for binding must execute synchronously; service-free types alone cannot rule out async transformations. Async encoding/round-trip failures need an Effectory diagnostic naming the key and stating that the codec must encode and round-trip synchronously; do not expose only Effect's unhelpful "Sync adapter can only throw schema errors". Effect decoding at execution remains Effect-based.
6. `Tag.provider(rawMap: Readonly<Record<string, string>>)` copies/freezes the typed map and returns the real `ConfigProvider.ConfigProvider` produced by `ConfigProvider.fromUnknown(snapshot, { preserveEmptyStrings: true })`. It adds no validation or intentional throwing path. Domain-specific invalid string values fail in the Config parsing Effect. It is not an unknown-input RunTags decoder; callers outside a task validate untrusted input through RunTags at their boundary first. This helper preserves empty-string semantics and snapshots the source without reimplementing ConfigProvider. It never reads or falls back to process.env and does not replace the task's ambient ConfigProvider. Existing context maps are already validated. Users may also construct a provider directly using Effect. Config.withDefault handles missing tags, not invalid present values; Config.option behaves similarly. Directly yielding `.config` uses Effect's ambient provider, which defaults to process.env; use context.readTags in handlers and explicit `.parse(Tag.provider(tags))` outside them.
7. `Tag.Input` is `ReadonlyArray<Tag.Binding> | Readonly<Record<string, string>>`. Authoring defaults/overrides, Task.test tags and publication options accept it. Arrays are the primary typed syntax; raw maps keep dynamic operator labels and existing publication callers possible. An array cannot mix bindings with plain pairs/records. Duplicate keys within one array are rejected even when values match; cross-layer override precedence is unchanged. Omitted, [] and {} have equivalent empty semantics. Present undefined remains invalid. Array order has no semantic effect after decoding. Workflow.Definition.tags / WorkflowSchedule.Definition.tags remain captured encoded maps, not arrays or live domain values. Public low-level RuntimeContext.tags remains an optional raw RunTags map because it is the host execution boundary.
8. `context.tags` remains the required frozen raw string map. Add `TaskContext.readTags: <A>(config: Config.Config<A>) => Effect.Effect<A, TaskRuntimeError>`, built in contextFor from a provider over the frozen map. No caller-supplied readTags member is required on low-level RuntimeContext. It calls config.parse(provider) and maps ConfigError to TaskRuntimeError / InvalidBoundary with a bounded key/issue message. It accepts Config.all, withDefault, option and other existing Config combinators unchanged; no unsafe generic `get<A>(key)` casting. Task.test fixtures accept binding arrays, and its publications report final encoded maps. Publication raw-map options retain their existing broader grammar; binding arrays inherently use the narrower run-tag key/value grammar but do not impose a new restriction on existing raw publication maps. Merged publication tags retain the existing 8192-byte budget. Run maps retain 32 keys / 256 UTF-16 value units / 4096 bytes. These limits are applied to encoded strings, not decoded objects or numbers. Binding errors name the key and encoded-string limit. Structured business data should use input or artifacts, given the small value budget.
9. RPC submissions, filters and outputs stay flat string maps governed by RunTags. The daemon already loads workflow definitions and can perform declared-codec validation if Option B is chosen; no CLI-side code loading is required. History and lake comparison are exact string comparison. Typed Shard(3) encodes "3"; a raw --tag shard=03 persists "03" and can read as number 3, but --tag shard=3 does not match that raw stored value. There is no global automatic canonicalization. This preserves request fingerprints and exact searches.
10. Admission validation is an explicit user decision; it is not settled by this draft. The two alternatives are described below. Neither installs a global tag catalog. Wire/history values remain encoded strings under both alternatives.
11. Definitions are reusable module exports. Their keys identify stored labels; there is no global object-identity registry. Two definitions with the same key but different schemas are independent readers of the same string and can disagree; conflicting bindings in the same array are rejected by key. Document reuse of one definition across producers/consumers. Defaults do not make every task require a tag. Linked child workflows continue to use the one host run's encoded map, with their own root-only defaults ignored as specified in the baseline.
12. Overlay, persistence, idempotency, scheduling, filtering and capability negotiation operate solely on encoded maps. No schema, ConfigProvider, binding object or decoded value is serialized. Tag-only schedule edits still preserve generation/watermark/pending slots. Replaying an accepted run uses its immutable strings with the pinned task code's readers. A different submitted encoded map still conflicts under the same manual request key. For programmatic binding arrays, equivalent encoded maps are equivalent requests; the CLI's different raw strings remain different requests. Artifact tags merge encoded strings, explicit publication labels winning as before. The existing operator-wins raw-map idiom `{ kind: "summary", ...context.tags }` still works.

## Admission validation — user decision

**Option A: typed authoring and reads, late domain validation.** The original revision has no declarations. CLI/raw values receive only generic RunTags validation at admission. `--tag env=garbage` is accepted, persisted, and fails when a task calls context.readTags with Environment.config. Similarly, `--tag dry-run=` is present but invalid, and fails even when the reader uses withDefault(false). Earlier tasks may already have produced side effects. A task that never reads it can publish it as metadata. Raw schedule overrides have the same late failure. No workflow-level discovery of expected tag codecs is provided. This is a smaller contract, but it does not validate all overrides against authored tag types.

**Option B: workflow-scoped declarations, recommended by the consumer reviewer.** A root workflow's tag array accepts bindings as declarations with defaults, and bare definitions as declarations without defaults: `tags: [Environment("dev"), Shard, Label]`. Only that workflow's declared keys are domain-validated at admission, after the existing dedup lookup and before any task runs. Undeclared dynamic labels remain allowed. Raw maps are still available; a raw-map-only workflow supplies defaults without declarations. Schedule construction validates its effective map against its workflow's declarations. Direct task runs and linked-child declarations do not add root validation; reads still validate locally.

The codec registry is captured on the Workflow definition, in-process, with no global lookup. This option requires bindings to retain a reference to their definition in addition to their snapshotted encoded string, overriding the binding-only storage rule in point 2. Declarations are stripped before serialization. Captured Workflow.Definition.tags remains the encoded default map; a separate readonly captured declaration collection supplies validation. Duplicate declarations/bindings of the same key are rejected within one workflow array. Bare definitions are not accepted in schedule overrides, Task.test fixtures or publications.

Validation preserves submitted strings: "03" remains "03" after successfully decoding as number 3. workflow describe would expose tagSchemas keyed by name using Effect JSON Schema conversion, with its usual inability to express every decoder refinement. Errors identify the declared key. There is no automatic canonicalization or cross-workflow registry.

Before implementing Option B, the chosen contract must specify optionality of bare declarations, whether a bound default makes a key required, declaration changes on schedules, and the exact captured/describe shapes. These were not defined by the consumer review; they are further API decisions, not internal details. Choosing B therefore triggers a focused design/review pass before implementation. The proposal should ask the user about early validation without presenting these unspecified details as ready to ship.

Under either option, export and reuse one tag definition per key. Different schemas for one key can disagree at read time. Option B makes the root workflow's declaration authoritative for admission only.

Dynamic values can be authored with `Tag.make("correlation", Schema.String)(value)` or a raw map. Arrays do not mix bindings and plain pairs/records. The operator-wins publication idiom uses the raw-map form `{ kind: "summary", ...context.tags }`; a binding array has no equivalent map spread.

## Effect evidence already probed

Pinned node_modules/effect 4.0.5, 2026-11-05. These are scratch runtime probes of existing Effect primitives, not tests of the nonexistent Tag API:

- Config.schema delegates to Schema.toCodecStringTree (Config.ts:1314). Config values expose parse(provider), support normal Config combinators, and are Effect values (Config.ts:113).
- ConfigProvider.fromUnknown supports preserveEmptyStrings; the default otherwise treats empty strings as missing (ConfigProvider.ts:1061). Literal dots/slashes remain one segment when the path is [key].
- Schema.toCodecStringTree(Schema.Int) encodes 3 as "3"; Config.schema reads "03" as 3. Boolean encodes true as "true"; its canonical parser rejects "yes".
- The proposed Schema.String/decodeTo/StringTree composition encodes/decodes Int and Boolean via standard Schema. A plain Struct fails to encode as a string. Schema.fromJsonString(Struct) encodes to JSON text and Config reads it back as a typed object.
- With preserveEmptyStrings:true, Config String reads "" as "". An Int with Config.withDefault(5) returns 5 for absence, fails for "oops" and "", and carries the key in its Schema issue.
- The Effect reviewer subsequently probed brands, async transformation failures, lossy unions and schema equivalence. A hand-written stand-in for Tag's signatures retained literal keys, rejected wrong calls/structural forgeries, accepted heterogeneous arrays and inferred Config.all correctly. This is evidence for feasibility, not a test of the real API. Real implementation error wrapping, runtime provenance and integration remain unproven.

## Required proofs added to baseline

1. Typecheck positive/negative call inference, literal key retention, heterogeneous binding arrays, brands, refinements, Config.all inference and task handler error composition. Show how to construct branded values using Effect Schema in the final examples. No new Effect service requirement. Ensure a wrong value cannot widen S via inference. Bare definitions must be rejected where only bindings are supported; only Option B would allow them in a workflow declaration array.
2. Test standard Schema codecs and explicit string transformations, scalar rejection, preserved empty strings, literal dotted/slashed keys, Config defaults/options distinguishing absent from malformed, canonical boolean spelling, JSON scalar codecs, duplicate keys and unsupported async binding encoders with useful errors. Reject lossy NullOr(String)("null") and Union([Int, String])("3") bindings using schema equivalence, while valid Date/brand/structured-string round-trips pass.
3. Verify array/map equivalence after encoding, binding/provider snapshots against later caller mutation, publication map compatibility, runtime rejection of forged bindings and all limits after overlay. Domain-specific checks on binding construction and Config reads must show the key; generic wire checks remain independent. contextFor normalizes publication Tag.Input to its encoded map before runtime.publish, whose low-level options retain their existing map type. A bad dynamic publication binding fails through the typed channel when the documented Effect.try pattern is followed.
4. Test/document the selected admission policy, unknown dynamic labels, and exact-string filters such as "03" versus "3". Raw-map fixtures must test malformed typed reads even if authored bindings reject the value earlier. Under Option B, also prove invalid declared values fail before any workflow step while undeclared labels remain accepted.
5. Confirm the public examples run after implementation, including readTags error mapping through Task.make and Task.test. Test that context.readTags uses run tags even when a conflicting environment variable exists, and record that direct yielding of .config observes the ambient provider, not run tags. Ordinary environment Config usage must remain unaffected. Regenerate host modules for Tag's export and run the baseline repository checks when source is implemented.

## Review focus

Effect review: verify these APIs against pinned sources, ensure actual Config reuse is appropriate, challenge synchronous binding versus Effect execution and the constraints of the string composition. Identify a smaller design if available without reimplementing Effect. Consumer review: evaluate the callable array syntax and the typed-read ergonomics, especially whether raw string admission and the error mapping violate reasonable expectations. Both: propose concrete corrections before user presentation; no production edits or new agents.

## Consumer round-1 resolution

Revision 2 adopts C1/C2: context.readTags binds the source and maps errors, while JSDoc and a regression proof disclose the direct-yield environment hazard. It applies C3 as a user choice, with the workflow-declaration alternative recommended by that reviewer. It also records defaults, fail-fast Config.all, encoded size limits, dynamic-map ergonomics and missing type proofs. The consumer reviewer requires no further round for these corrections.

## Effect round-1 resolution

Revision 3 applies F1–F5: explicit run-tag provider selection (through context.readTags in handlers, parse outside them), schema equivalence for binding round-trips, a non-validating snapshot provider, Effect.try for dynamic in-handler binding creation, explicit daemon-side admission choice, corrected unsupported-schema and async failure claims, fixed-schema inference explanation, branded construction and runtime binding provenance. The consumer-requested readTags helper owns the TaskRuntimeError mapping; the lower-level parse path retains ConfigError as the Effect reviewer requested. Both reviewers said another round is unnecessary for these corrections. Option B's complete admission contract still needs design/review after the user chooses it. No public implementation is approved.

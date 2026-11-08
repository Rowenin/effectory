# Typed metadata tags — context-reader proposal, pending DI revision

The user subsequently proposed `yield* Team.value()` backed by Effect DI and asked that Scope and Layer design be researched explicitly. The context.readTag shape below was reviewed but not approved by the user. See [the runtime research queue](runtime-research-queue.md) before finalizing the service-based replacement. The approved optional declarations and present-value validation rules remain in force.

The user asked whether Swamp treats tags as configuration. The pinned source treats them primarily as run/artifact labels, while exposing them for inspection in workflow expressions and method context. The user agreed to keep typed metadata authoring and reconsider Config in the public reading API. The examples using DryRun as a tag were misleading: execution controls belong in workflow input, and application configuration can use Effect Config independently.

This document changes only the read surface and related examples of [the previously approved contract](run-tags-contract.md). The user explicitly chose optional bare declarations: validate present values at workflow admission, allow absence. No public implementation exists. Review this delta before presenting its concrete syntax to the user.

## Proposed consumer shape

```ts
// PROPOSED: Tag API does not exist yet.
import { Application, Tag, Task, Workflow } from "@offtree/effectory-sdk";
import { Effect, Option, Schema } from "effect";

const Team = Tag.make("team", Schema.NonEmptyString);
const Deployment = Tag.make("deployment", Schema.NonEmptyString);
const Build = Tag.make("build", Schema.Int);
const Classification = Tag.make(
  "classification",
  Schema.Literals(["internal", "public"])
);
const Metadata = Schema.Struct({
  team: Schema.String,
  deployment: Schema.NullOr(Schema.String),
  build: Schema.NullOr(Schema.Int),
});

const Inspect = Task.make(
  {
    id: "inspect-metadata",
    version: 1,
    input: Schema.Null,
    success: Metadata,
    error: Schema.Never,
    replay: "idempotent",
  },
  (_, context) =>
    Effect.gen(function* () {
      const metadata = yield* Effect.all({
        team: context.readTag(Team),
        deployment: context.readTag(Deployment),
        build: context.readTag(Build),
      });
      return {
        team: Option.getOrElse(metadata.team, () => "unassigned"),
        deployment: Option.getOrNull(metadata.deployment),
        build: Option.getOrNull(metadata.build),
      };
    })
);

const InspectWorkflow = Workflow.make(
  {
    id: "inspect-metadata",
    version: 1,
    input: Schema.Null,
    success: Metadata,
    error: Schema.Never,
    tags: [Team("platform"), Classification("internal"), Deployment, Build],
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    return yield* graph.task("inspect", Inspect, null);
  })
);

export default Application.make({
  tasks: [Inspect],
  workflows: [InspectWorkflow],
});
```

```sh
effectory workflow run inspect-metadata --input null --tag deployment=deploy-42 --tag build=042
```

`context.tags.build` retains the stored label "042", while `readTag(Build)` yields Some(42), its decoded view. Build and Deployment have no workflow defaults and are optional at admission. Team and Classification have reusable metadata defaults; build numbers are supplied per run.

A task can explicitly fail if it cannot proceed without some metadata, using standard Effect rather than a throwing Option accessor:

```ts
// PROPOSED; shares Inspect and Deployment from the example above.
import { TaskRuntimeError } from "@offtree/effectory-sdk";

const RequireDeployment = Task.make(
  { ...Inspect.spec, id: "require-deployment", success: Schema.String },
  (_, context) =>
    context.readTag(Deployment).pipe(
      Effect.flatMap((value) =>
        Effect.fromOption(
          value,
          () =>
            new TaskRuntimeError({
              code: "InvalidBoundary",
              message: "This task needs the run tag 'deployment'",
            })
        )
      )
    )
);
```

That failure is a local decision at execution time. It does not make a declaration required at admission, and earlier workflow steps may already have run. Use workflow input for mandatory execution parameters. The example demonstrates typed error handling for a task inspecting metadata, not a new required-tag mode. Do not use Option.getOrThrow inside a handler for this case.

## Exact delta

1. Keep `Tag.make(key, schema)`, the typed callable binding syntax, opaque binding/definition provenance, `Tag.Input`, `Tag.Declarations`, optional bare workflow declarations, captured tags/tagSchemas maps and the source codec on bindings. A definition exposes `key` and `codec`; **remove `.config`**. Remove `Tag.provider` and the proposed `context.readTags(config)`. No Config or ConfigProvider is required for tag reading, even internally.
2. Add one member to TaskContext: `readTag<Key extends string, S extends Boundary>(definition: Tag.Definition<Key, S>): Effect.Effect<Option.Option<S["Type"]>, TaskRuntimeError>`. This is a proposal signature; actual inference must be verified. No new service requirement or Layer. RuntimeContext callers still supply the raw map, not a read function. contextFor constructs the method for production, task implementations/providers and Task.test.
3. Each evaluation validates definition provenance, checks own-key presence in the attempt's frozen raw map and returns Option.none for absence. For a present value it runs `Schema.decodeUnknownEffect(definition.codec)(rawString)` and wraps the decoded result in Option.some. A present empty string is not missing: String accepts it, NonEmptyString rejects it. A present decoded null/undefined is Some(null)/Some(undefined), not None. Inference preserves branded/domain types.
4. Map SchemaError to the existing TaskRuntimeError with code "InvalidBoundary" and a bounded message of the form `Invalid run tag \`<key>\`: <SchemaError message>`. Retain rendered issue text, not a new field or error class. Do not silently turn invalid values into absence or use a fallback for them. Missing metadata succeeds with None. Existing Effect error/defect semantics apply to custom decoders: typed Schema failures are mapped; defects are not magically made valid values. Invalid definition provenance is a typed InvalidBoundary failure before decoding, including when the named key is absent. All read work, including provenance checks, is inside Effect.suspend: calling readTag(forged) without evaluating the returned Effect never throws.
5. Each read uses the stored string and the passed definition's codec. No cache of decoded values is shared across calls/attempts, so mutable decoded values cannot contaminate later reads. As elsewhere, custom codecs must be deterministic and free of external side effects. Async decoding works incidentally through the Effect read, but synchronous codecs are recommended throughout: admission of present declared values and authored binding construction retain the synchronous boundary restriction from the approved contract.
6. `context.tags` remains the raw frozen string map for inspection and metadata propagation. Reads do not mutate it or add defaults to it. `Option.getOrElse` supplies a local read fallback, which is not an authored default or a newly published label. `Effect.all`, Effect.map/flatMap and Option operations supply composition; do not introduce Tag.all, Tag.option, Tag.withDefault or a bespoke collection wrapper.
7. A read need not correspond to a declaration on the submitting root. The codec passed to the read is authoritative for that read; the root's captured codec remains authoritative at admission. Reuse shared tag definitions to avoid disagreeing schemas for the same key. Linked child and direct task limitations remain as approved. A root default does not make the read type non-optional: tasks can run directly or under other roots.
8. Outside handlers, consumers can use the real `definition.codec` with standard Schema decoding/encoding and standard Record/Option presence handling. Use decodeUnknownEffect/Exit and an own-key check or Record.get to distinguish absent from invalid. decodeUnknownOption or converting a decoding failure to Option would collapse invalid into missing. No extra standalone Tag read/provider API is necessary in this slice. The definition itself is not yieldable and has no ambient lookup. This eliminates the earlier accidental environment read path.
9. Retain the same canonical string codec: `Schema.String.pipe(Schema.decodeTo(Schema.toCodecStringTree(schema)))`. The use of StringTree is an Effect Schema conversion facility, not a promise that tags are configuration. It enables Schema.Int/Boolean/literals/refinements without a custom parser. Binding round-trip equivalence, runtime provenance, synchronous Exit/Cause classification, branded construction and the documented Effect.try pattern for dynamic binding construction remain unchanged.
10. Keep optional declarations and early validation of supplied values. The daemon validates present declared tags before admission and stores exact strings; unknown labels remain allowed. Missing bare declarations are accepted. The read returns None for absence; the application chooses how to handle it with Option. No required tag mode, defaulting reader service or optional-marker DSL is added. Schedule/default/schema edits preserve the already approved identity/receipt rules.
11. Metadata can be observed by application code, as in Swamp, but examples and documentation should use ownership, deployment/correlation IDs, classification and build identifiers. Do not use tags to exemplify dry-run switches, retries, timeouts or mandatory execution arguments. Those belong in the existing input/configuration APIs. We do not forbid consumers from branching on metadata.

## Focused proofs

- `readTag(Team)` infers Effect<Option<string>, TaskRuntimeError>, Build infers Option<number>, brands retain their type, and Effect.all preserves heterogeneous results. Task.make with Schema.Never accepts this reader and the explicit Effect.fromOption error without a new error mapping.
- Absent => None; valid present => Some; invalid present => typed failure. Empty String remains Some(""); nullable/undefined outputs retain the outer Some. Local Option defaults do not write tags or alter inherited artifact labels.
- Invalid present build metadata produces a TaskRuntimeError message containing both the key "build" and the Schema issue; raw Schema errors alone do not include the tag key. The "042" stored/raw versus Some(42) decoded distinction is tested.
- Reads are lazy, decode on each evaluation, use fresh attempt snapshots and never consult process.env or an ambient ConfigProvider. An async codec can read successfully even though binding/admission reject suspended codec execution.
- Forged definitions fail through the typed channel; merely copying the key/codec is insufficient. Reusing a canonical module-exported definition works in normal host bundles.
- Calling readTag(forged) without evaluating it does not throw. With a matching process.env key set but the run tag absent, reading returns None.
- Regenerate hostModuleLoaders to include @offtree/effectory-sdk/Tag. Tag provenance registration and contextFor checks must use the same module instance shared by application/extension bundles. Test a definition exported by an extension and read by an application task, and the reverse. A definition from a duplicated SDK instance fails with InvalidBoundary, never silent None.
- No Config/ConfigProvider or removed methods survive in public Tag exports/types/examples. Old proposal documents remain historical and link to this revision.
- All earlier optional admission, scheduling, persistence, query, CLI, publication and compatibility tests still apply; update Config-oriented test cases to the corresponding Effect/Option behavior.

## Review scope

Effect POV: is this actually smaller and idiomatic? Check inference, Option semantics, lazy decoding/error mapping, schema-codec reuse, provenance and async boundaries without introducing a new DSL. Consumer POV: does it read as metadata, is absence explicit without excess ceremony, and does it preserve the requested authoring ergonomics? Request concrete minimal fixes. No production changes, no subagents, no new rounds for small text fixes.

## Consumer round-1 resolution

M1–M4 are applied: explicit Effect.fromOption typed missing-value idiom, a complete proposed handler/workflow/application plus CLI example, metadata-oriented defaults and matching variable/key names, and raw-versus-decoded/key-in-error behavior. No new consumer review is required. When the final reader is approved, replace the Config-centric example in run-tags-contract.md with this one; the historical contract's revision banner already points here. Examples are not yet typechecked against an implementation.

## Effect round-1 resolution and replacement map

M1–M4 are applied: the replacement map below, exact error code/message and lazy provenance check, shared host-module requirements and cross-bundle tests, and guidance about synchronous codecs and not collapsing invalid values into absence. The reviewer typechecked and ran a stand-in successfully; inference of Int/literals/brands/nullable values and Effect.all is supported by that probe. Real implementation tests are still required. Neither reviewer needs another round for these corrections. User approval of this revised read surface is pending.

This revision replaces these passages in run-tags-contract.md:

- Authoring/reading Config.all example, .config, Tag.provider and context.readTags: replaced by the complete example here, context.readTag and Effect.all.
- Config.withDefault/option: replaced by Option.getOrElse and explicit Option handling after readTag. Missing is None; invalid is a typed failure; a local fallback does not change stored metadata.
- Required Config read / removing a default exposing a missing handler value: replaced by the explicit Effect.fromOption typed-failure idiom. A task can fail locally on None, after earlier steps have run, without changing optional admission.
- Async Task Config reads: replaced by Schema.decodeUnknownEffect in the reader, with incidental async support and a recommendation to use synchronous codecs for admission compatibility.
- Config-oriented verification (absent boolean defaults and environment collision): replaced by absent tag => None, Option.getOrElse fallback, present invalid => failure, and an explicit test that a colliding environment variable is ignored.

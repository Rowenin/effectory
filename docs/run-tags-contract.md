# Run tags

This is the implemented contract. It supersedes the earlier Config, `context.readTag`, and required-declaration proposals. The user selected optional declarations and `yield* Team.value()` through Effect dependency injection. Claude reviewed both the consumer API and Effect provisioning; see [consumer review](run-tags-di-review-consumer.md) and [Effect review](run-tags-di-review-effect.md).

## Authoring

```ts
import { Application, Tag, Task, Workflow } from "@offtree/effectory-sdk";
import { Effect, Option, Schema } from "effect";

const Team = Tag.make("team", Schema.NonEmptyString);
const Build = Tag.make("build", Schema.Int);

const Report = Task.make(
  {
    id: "report",
    version: 1,
    input: Schema.Null,
    success: Schema.String,
    error: Schema.Never,
    replay: "idempotent",
  },
  () =>
    Effect.gen(function* () {
      const team = Option.getOrElse(yield* Team.value(), () => "unassigned");
      const build = Option.getOrElse(yield* Build.value(), () => 0);
      return `${team}: build ${build}`;
    })
);

const Reporting = Workflow.make(
  {
    id: "reporting",
    version: 1,
    input: Schema.Null,
    success: Schema.String,
    error: Schema.Never,
    tags: [Team("platform"), Build],
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    return yield* graph.task("report", Report, null);
  })
);

export default Application.make({
  tasks: [Report],
  workflows: [Reporting],
}) satisfies Application.Application<never>;
```

`Team("platform")` binds an encoded default. A bare `Build` declares an optional typed label: admission validates it **when present**, and absence stays valid. Unknown labels are allowed. Duplicate keys in a declaration/binding array fail, including `[Build, Build(42)]`. A raw string map is also accepted, but does not declare schemas.

Binding constructors are synchronous definitions and throw `DefinitionError` for invalid values. If a task constructs a binding from dynamic data, wrap it in ordinary `Effect.try` and map the failure to its declared error or `TaskRuntimeError`; do not let an unchecked constructor throw from the handler.

Tags are metadata for classification, correlation and querying. Required business parameters belong in workflow input schemas. A task can choose to fail when an optional tag is absent, using ordinary `Option`/`Effect` operations and its declared error or `TaskRuntimeError`. This does not make the tag required at admission.

## Reading and Layers

`Team.value()` returns `Effect<Option<string>, TaskRuntimeError, Tag.Values>`. Absence is `None`; a malformed present value fails with `InvalidBoundary` and a message naming the key. A raw value `"042"` remains `"042"` in storage and `context.tags`, while `Build.value()` produces `Some(42)`. Null values decoded by a nullable schema remain `Some(null)`. Reads are lazy, decode on every evaluation, and never consult environment variables.

Use `Effect.all` to combine reads and `Option.getOrElse` for local fallbacks. Outside a task, ordinary `Effect.provideService(Tag.Values, { team: "platform" })` or `Layer.succeed(Tag.Values, ...)` supplies encoded strings. There is no default service, Config reader, custom combinator family or context reader method. Export forms are `import { Tag, RunTags } from "@offtree/effectory-sdk"`, `import * as Tag from "@offtree/effectory-sdk/Tag"`, and `import { RunTags } from "@offtree/effectory-sdk/RunTags"`.

The task boundary validates and freezes one raw snapshot, shared by `context.tags` and `Tag.Values`, for each invocation/attempt. `Task.make`, `Task.implementation`, and `.provide` remove only the runner-owned `Tag.Values` requirement. Other dependencies remain inferred. Low-level `RuntimeContext.tags` is optional for compatibility; omission becomes `{}`, while an explicitly present `undefined` is invalid.

Layers that read run tags belong on `Task.provide`. Application/revision Layers build before a run exists. Use `satisfies Application.Application<never>` on the exported application to catch leftover dependencies. Each invocation gets a fresh root Layer memo map; nested task provisions can share within that invocation, but cannot reuse an application-built instance. Effect owns the task-local Layer scope and its finalizers. A frozen metadata map itself needs no new Scope. Retries acquire again.

Provision priority follows Effect nesting: the runner snapshot overrides caller/application provisioning; an explicit task-local `Task.provide(Layer.succeed(Tag.Values, ...))` or a narrower `Effect.provideService` overrides reads inside it. Such a deliberate override does not rewrite `context.tags`, persisted metadata or automatic publication inheritance. Services use the stable key `@offtree/effectory-sdk/Tag/Values`; duplicate SDK copies can read that service. Binding/declaration provenance is separate and rejects foreign module copies. The host shares the Tag module between application and extension bundles.

## Boundaries and inheritance

Tag schemas must encode to strings through Effect's string-tree codec. Bindings encode, decode and compare with `Schema.toEquivalence`; lossy values fail. Plain object/array schemas are not implicit JSON tags: use a string codec deliberately if needed. Prefer simple scalar schemas. Construction and admission require synchronous codecs; async encoding/decoding gets an explicit declaration error. Read-time decoding uses the ordinary Effect schema decoder and can be asynchronous. User codec defects remain defects when reading.

`Workflow.make` captures frozen defaults and declared codecs independently of later mutation of its spec. Manual workflow admission merges defaults then supplied values, validates all present declared values, and stores the exact strings. Validation runs before execution, outside SQLite transactions. Direct task runs have no workflow declarations. Linked children inherit the root run's labels; their defaults and declarations are not applied. A child submitted as the root uses its own declarations.

`WorkflowSchedule.make({ ..., tags: [Team("operations")] })` adds overrides and validates the merged map against its workflow. An invalid schedule prevents the application revision from loading. Tags and tag schemas are excluded from schedule identity: tag-only edits preserve generation, watermark and pending admission. Already admitted runs retain their original snapshot. Changed declarations can still reject future manual runs or make a schedule invalid if an existing value no longer decodes.

`context.publish(..., { key, tags })` merges run labels followed by explicit publication labels. Explicit values win; `{ tags: {} }` keeps inherited labels. Use `{ kind: "report", ...context.tags }` when the operator's values should win. Typed binding arrays and existing raw publication maps are supported. Publication maps retain their wider existing rules and 8192-byte budget; run tags have a smaller 4096-byte budget to leave room for task labels. `Task.test(task, { input, tags })` uses the same lazy boundary and records final merged `TestPublication.tags`.

## CLI, RPC and storage

```sh
effectory workflow run reporting --input null --tag build=042 --tag deployment=deploy-42
effectory task run report --input null --tag team=platform
effectory run list --tag team=platform --tag deployment=deploy-42
```

Repeat `--tag KEY=VALUE`; split at the first `=`, retain empty values, reject duplicate keys. Every list predicate must match exactly. `WorkflowRun`, `TaskRun`, and `RunList` RPC requests accept an optional encoded `tags` map. Runs, summaries/watch snapshots, schedule descriptions and workflow descriptions/plans expose tags. Workflow descriptions/plans also expose `tagSchemas`, generated with `Schema.toJsonSchemaDocument(Schema.toType(codec))`: these describe decoded values, whereas defaults and CLI inputs are strings. Brands/custom checks are not fully represented; Date is a string and nullable schemas can show null without making a key required.

A tagged CLI operation checks `run-tags.v1` before sending its request. An old daemon is refused with upgrade/restart guidance. Untagged operations omit the field; clients decode missing tags in old replies as `{}`, but reject malformed present maps. Old daemons also ignore new workflow defaults until upgraded and restarted. New servers strictly decode the stored tag column and always return the field.

`RunTags` permits at most 32 keys, each matching `[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}`, string values of at most 256 UTF-16 code units, and at most 4096 UTF-8 bytes of JSON in the whole map. Empty strings are valid metadata, though a declared schema can reject them. Limits apply after merging. Invalid constructor values throw `DefinitionError`; invalid submissions fail `InvalidInput`; invalid task fixtures/reads fail `TaskRuntimeError`. Plain/null-prototype authoring maps are supported; Date/Map objects are rejected.

Run tags are persisted atomically with admission and an indexed tag table. All tag predicates execute in SQLite before matching rows count toward the 10,000-row and 16 MiB history budgets. Tags themselves count toward the byte budget. Cursor identity includes normalized tag filters, independent of key order; omitted and empty filters agree. Existing rows migrate to `{}` under the store's exclusive ownership.

Request-key fingerprints include only nonempty **caller-supplied** tags. Defaults are resolved after the existing receipt lookup, so a retry returns its original run after defaults change. Empty tags preserve prior fingerprints. Scheduled admission identity excludes tags. The persisted snapshot survives process restart; this feature does not change the existing host ABI policy for resuming old builds.

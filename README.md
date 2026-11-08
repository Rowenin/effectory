# Effectory

An Effect-native TypeScript automation library with a durable graph runner, authenticated local RPC daemon, CLI, GitHub extensions and queryable JSON artifact lake. The bounded v0 implementation passes its local checks and live public/private GitHub extension installation and offline restore checks; see [implementation status](docs/implementation-status.md) and the [release checklist](docs/release-checklist.md).

## Agent setup

Prepare project-local guidance for Codex and Claude Code after initializing a project:

```sh
effectory agent setup --harness codex --harness claude-code --dry-run
effectory agent setup --harness codex --harness claude-code
effectory agent status
```

Setup also updates and repairs managed files. It detects edits instead of overwriting them, and does not launch agents or change their permissions. See [setup, removal and interrupted-update recovery](docs/agent-setup.md).

## The customer API

Define tasks and workflows, then export an application from `effectory.ts`. The runner loads that application. Files can be organized however you prefer; ordinary TypeScript imports determine what belongs to the application.

```ts
import { Application, Task, Workflow } from "@offtree/effectory-sdk";
// effectory.ts
import { Effect, Schema } from "effect";

const Greet = Task.make(
  {
    id: "greet",
    version: 1,
    input: Schema.Struct({ name: Schema.String }),
    success: Schema.String,
    error: Schema.Never,
    replay: "idempotent",
  },
  ({ name }) => Effect.succeed(`Hello, ${name}`)
);

const Welcome = Workflow.make(
  {
    id: "welcome",
    version: 1,
    input: Greet.inputSchema,
    success: Schema.String,
    error: Schema.Never,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const input = yield* graph.input(Greet.inputSchema);
    return yield* graph.task("greeting", Greet, input);
  })
);

export default Application.make({
  tasks: [Greet],
  workflows: [Welcome],
});
```

Graph-based workflows are the selected direction. The second argument to `Workflow.make` is an Effect that constructs the graph. `graph.task` registers a node and returns a reference; the runner executes the task later. Effect operators on construction do not automatically become durable execution policies.

The implemented graph surface includes:

| API | Runtime behavior |
| --- | --- |
| `graph.task(id, Task, input, options?)` | Durable task invocation; mixed literals and typed references; optional `after` dependencies |
| `graph.map(id, { input, success }, compute)` | Schema-backed pure computation with a persisted result |
| `graph.branch(id, condition, { success, onTrue, onFalse })` | Builds both cases; executes only the selected graph |
| `graph.forEach(id, items, { item, success, key, concurrency, maxItems }, build)` | Bounded keyed item scopes; output order follows the captured input |
| `graph.workflow(id, Child, input, options?)` | Linked child graph with its own schemas and inherited leaf-task limits |
| `graph.sleep(id, duration, options?)` | Persistent delay, including short durations |
| `graph.approval`, `graph.requestInput`, `graph.waitForSignal` | Durable, schema-validated interaction through the CLI/RPC |
| `graph.registerSignal` / `graph.awaitSignal` | Open a receiver before triggering an external job, then await its recorded response |

`execution: { concurrency: 4 }` on a workflow limits active leaf tasks across its children. Task invocation retries use `{ retry: { attempts: 3, delay: "1 second", when: ["RateLimited"] } }`; attempts includes the initial attempt, and only matching tagged domain errors are retried. Automatic retries require `replay: "idempotent"`. Backoff releases task permits and retains its deadline through restart. Task `timeout` starts after dependencies and before-step patches finish, and includes permit queueing and backoff; `attemptTimeout` starts at admission. Workflow `execution.timeout` bounds its children, and deadlines never reset on restart. The host admits at most 32 active handlers. Cleanup that remains unfinished two seconds after a stop request is held in `NeedsAttention`; other runs can continue, and terminal projection waits for actual quiescence.

Signal handles have exactly one await consumer in their construction scope. Passing `receiver.address` into the trigger task establishes the registration dependency; `graph.awaitSignal("completion", receiver, { after: [trigger] })` also requires the trigger to succeed. The address carries run/wait identity, not authentication credentials. See the executable [operator tests](packages/platform-bun/test/operators.test.ts) for complete examples.

Schedules are application-owned specifications. A schedule discovers its workflow automatically; its tasks and service Layers are registered normally:

```ts
import { WorkflowSchedule } from "@offtree/effectory-sdk";

const HourlyWelcome = WorkflowSchedule.make({
  id: "hourly-welcome",
  workflow: Welcome,
  input: { name: "Ada" },
  cron: "0 * * * *",
  timeZone: "America/Chicago",
  catchUp: { latestWithin: "1 hour" },
});

export default Application.make({
  tasks: [Greet],
  schedules: [HourlyWelcome],
});
```

The constructor validates fixed input against the workflow's decoded schema type and stores an immutable encoded copy. Cron uses five fields; UTC and `catchUp: "skip"` are defaults. The daemon must be running. Each schedule permits one unfinished scheduled run, including one waiting for approval or needing attention. Manual runs and other schedules remain independent. New schedules start at their next future occurrence. Unchanged schedules recover after restart, considering only the latest due occurrence: within a 60-second grace it is on time, otherwise the optional catch-up window applies.

```sh
bun run effectory daemon start --repository examples/scheduled
bun run effectory schedule list --repository examples/scheduled --json
bun run effectory schedule get minute-greeting --repository examples/scheduled --json
bun run effectory schedule history minute-greeting --repository examples/scheduled --json
bun run effectory schedule pause minute-greeting --reason maintenance --repository examples/scheduled --json
bun run effectory schedule resume minute-greeting --repository examples/scheduled --json
bun run effectory daemon stop --repository examples/scheduled
```

Pause stops future admissions and survives source edits/removal; accepted runs continue. Resume starts strictly after its operation time. The CLI generates mutation keys; reuse `--request-key` and the same operation/reason after uncertain delivery. The newest 256 mutation receipts per schedule provide deduplication; older evicted keys are treated as new requests. `schedule list` supports `--workflow`, `--state active|blocked|paused|removed` and paging; removed schedules are excluded by default. Scheduled runs appear in normal `run get`, `run list` and watch snapshots with a `schedule` provenance field. `daemon status` reports scheduler revision, counts, diagnostics and limits. Each schedule retains up to 1000 history entries, coalescing misses. A changed/pruned history cursor expires explicitly.

The [scheduled example](examples/scheduled/effectory.ts) waits for approval so its blocker is visible. See the [approved scheduling contract](docs/scheduling-api-draft.md) for DST behavior, generations, retention and CLI/RPC schemas. Nicknames, seconds fields and `L/#/W/?` are unsupported. Schedules share the existing source activation rules and single-owner daemon.

Tasks can inspect the scheduled occurrence through their existing context. Manual runs omit `context.occurrence`; scheduled tasks, retries, linked children and extension tasks receive a frozen snapshot of the run’s stored metadata:

```ts
const ReadOccurrence = Task.make(
  {
    id: "read-occurrence",
    version: 1,
    input: Schema.Null,
    success: Schema.NullOr(WorkflowSchedule.Occurrence),
    error: Schema.Never,
    replay: "idempotent",
  },
  (_, context) => Effect.succeed(context.occurrence ?? null)
);

const example = Task.test(ReadOccurrence, {
  input: null,
  occurrence: {
    scheduleId: "hourly-welcome",
    generation: 7,
    scheduledFor: "2026-11-05T10:00:00.000Z",
    catchUp: true,
  },
});
```

`scheduledFor` identifies the scheduled slot, not when the handler started. `catchUp` records late admission, not current staleness. `generation` is an opaque host-issued token: compare it within one schedule ID, not as an edit count. Missed slots can leave gaps; tasks requiring complete coverage need their own watermark. Use `new Date(...).toISOString()` for fixture timestamps; invalid fixtures fail lazily with `InvalidBoundary`. Omit `occurrence` for manual tests rather than passing `undefined`.

For a slot-based publication key, use `slot-${Date.parse(occurrence.scheduledFor)}`; raw ISO timestamps contain colons that keys reject. The publication key selects an artifact across runs, with subsequent publications adding versions. `context.key(...)` remains scoped to one run and invocation. See the [occurrence contract](docs/scheduled-task-context-api-draft.md) for validation and retry semantics.

Extension authoring and explicit selection are also implemented:

```ts
const Tools = Extension.make({
  id: "acme/tools",
  version: "1.0.0",
  tasks: { InspectRelease },
  implementations: [CachedFetch],
  patches: [ReviewPublish],
});

// Inside any workflow construction Effect:
const release =
  yield * graph.task("inspect", Tools.tasks.InspectRelease, input);

// Include contributions once. Replacements and patches require selection.
export default Application.make({
  tasks: [FetchRelease, Publish],
  workflows: [Release],
  extensions: [
    Extension.use(Tools, {
      implementations: [CachedFetch.providerId],
      patches: [
        {
          id: "review-publish",
          use: ReviewPublish.id,
          workflow: { id: Release.id, version: 1 },
          at: ["publish"],
        },
      ],
    }),
  ],
}).provide(Services);
```

The names above refer to definitions supplied by the application/extension. `Task.implementation({ id, target }, handler)` preserves the canonical target contract. `WorkflowPatch.make({ id, target }, input => constructionEffect)` builds a scoped before-step graph using the target's captured input. The target waits for every selected patch; rejecting a patch approval prevents dispatch. Bindings may declare `after: ["other-binding"]` on the same target. Nested selectors use explicit branch/item segments. `workflow plan` reports selected providers and patch graphs.

The [extension example](examples/extensions/effectory.ts) separates contracts, implementations and a typed facade. It is a local fixture. The installer primitives now validate GitHub assets and archives, restore immutable caches, and generate typed facades. For a repository with a tracked lockfile, `extension restore --trust` prepares those packages and records local trust; subsequent restores work offline from verified cache bytes. Startup restores bindings and validates executable exports before application loading. CLI/RPC `extension add`, `update` and `remove` return persisted operation receipts. Inspect them with `operation get <id>` or `operation list`. New package digests require explicit `--trust`; installation does not select contributions or overrides. Candidate updates compile against temporary bindings and activate only after validation. Existing runs keep their original bundle. Extra public contract exports, such as service identifiers, are available through `ReleaseTools.exports`. Its integration test verifies canonical schemas/services across bundling and retention of old providers/patches after daemon restart.

For a published extension archive, use the running repository daemon:

```sh
bun run effectory extension add github:acme/release-tools@v1.0.0 --as ReleaseTools --trust
bun run effectory operation get <operation-id>
bun run effectory extension list
bun run effectory extension outdated
bun run effectory extension update acme/release-tools --to v2.0.0 --trust
```

The repository and extension names here are illustrative. `extension list` reports installed and active application revisions separately. Add `--expected-revision <installed-revision>` to enforce a specific registry snapshot. On uncertain delivery the CLI prints both that revision and the request key to reuse. A failed operation is returned as data by `operation get`; it does not change the active application. Application source remains responsible for `Extension.use(...)` and override selection. `extension outdated` reads release metadata only. It reports whether the installed tag differs from [GitHub’s latest full release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release), which is not a semantic-version upgrade guarantee. Pages are bounded to 20 roots; subsequent pages reuse `--revision` and `--after` from the response.

From this checkout, try the complete approval/publication example:

```sh
bun install
bun run effectory daemon start --repository examples/greeting
bun run effectory workflow describe example/welcome --repository examples/greeting --json
bun run effectory workflow run example/welcome --input '{"name":"Ada"}' \
  --request-key greeting-1 --background --repository examples/greeting --json
bun run effectory run waits <run-id> --repository examples/greeting --json
bun run effectory run approve <wait-id> --request-key review-1 --repository examples/greeting --json
bun run effectory run watch <run-id> --repository examples/greeting --json
bun run effectory lake query --file examples/greeting/query.json --repository examples/greeting --json
bun run effectory daemon stop --repository examples/greeting
```

The [example application](examples/greeting/effectory.ts) declares both tasks, the approval and the artifact's queryable field. Use the IDs returned by the preceding commands. `daemon serve` runs in the foreground; `daemon start` starts a background process. Source changes take effect on the next daemon start. Existing runs retain their executable application revisions. Retained revisions also pin the host ABI; changing the host implementation currently rejects incompatible revisions rather than migrating them. `dev`/source watching is not implemented yet.

The daemon stores state under the selected repository's `.effectory/`, binds to authenticated loopback HTTP, and holds exclusive repository ownership. A background command returns after durable acceptance. Invalid inputs are rejected before handlers run. `run watch` uses a bounded RPC stream. It shows human progress on stderr and prints the final run JSON on stdout. Use `--json` to suppress human progress or `--jsonl` for snapshot, ordered event and heartbeat frames. Resume plain or JSON Lines observation with `--after-sequence <last-event-sequence>`; out-of-range cursors fail with exit 2. Scripts merging stderr with stdout should use `--json`. Human mode drains the recorded event tail before returning and disables progress if stderr breaks. Snapshot `lastSequence` is the current projection and may be ahead of replayed events: only advance a consumer checkpoint after processing an Event frame. Disconnecting observation does not cancel execution. Live observation requires `run.watch.stream.v1`; restart an older daemon with the current binary. Foreground commands remain attached through timers/retries, queued or executing task work, and resource cleanup. They return exit 4 when a Waiting run has an open interaction or the run needs attention. A signal registered before a durable sleep can still cause exit 4 during that sleep. Remote disconnects retain the run ID and exit 3; local Ctrl-C exits 130. Oversized events fail explicitly with exit 5 and an opt-in JSONL skip command. See [live observation](docs/live-run-observation.md) for cursor semantics, limits and recovery.

Inspection commands return pages with `items`, `cursor` and `snapshot`. Repeat filters and `--limit` when supplying `--cursor`:

```sh
bun run effectory run list --status Waiting --limit 20 --json
bun run effectory run waits --kind approval --json
bun run effectory run events <run-id> --limit 50 --json
bun run effectory run logs <run-id> --level Warn --json
bun run effectory run outputs <run-id> --json
bun run effectory run cancel <run-id> --reason 'No longer needed' --request-key stop-1 --json
```

[Manual recovery](docs/manual-recovery.md) inspects uncertain manual tasks without mutation: `effectory run recover <run-id>`. Authorize the whole assessed set with `--authorize <token> --acknowledge-reexecution`; `--request-key` makes lost-response retries safe. Re-entry preserves the original run, pinned code and completed work, but can repeat external actions. Task-timeout windows restart; absolute workflow deadlines do not. Recovery and cancellation require a compatible host build.

`run waits` defaults to open waits; use `--status all` for settled interactions, and `run wait <wait-id>` for context, response schema and payload. Event cursors pin an immutable sequence range. Run, wait and task-output pages exclude later admissions but show current status/results for the original members. Definition discovery cursors retain the application revision even during activation. Cursors expire after one hour.

Ordinary `Effect.log*` calls inside task handlers are captured with node and attempt identity. Logs and `context.progress` are best effort, sharing a persistent 1,000-entry / 1 MiB budget per run and an 8 KiB entry limit. One `TelemetryTruncated` event records exhaustion; control events remain available. Log values that cannot fit bounded JSON are replaced with an omission marker. These limits do not sandbox privileged application code or capture direct `console.log` calls. `run outputs` reads the native Effect task outcomes without executing handlers; artifact publications remain queryable through the lake.

The lake supports `And`, `Or`, `Not`, `Eq`, `Gt`, `Gte`, `Lt`, `Lte` and `In`, using metadata, tags and declared JSON fields. Optional `select: [{ name, field }]` adds named values to each row's `projection`; provenance metadata remains present. `orderBy: [{ field, direction: "asc" | "desc" }]` uses artifact ID/version to break ties. Range and ordered fields must have one encoded string or numeric type, optionally nullable. Use `Schema.Finite` for numeric query fields. Missing comparisons are false, null matches null, and missing projected fields are omitted. Cursors retain their original commit snapshot and latest-as-of versions.

`lake versions <artifact-id>` pages exact version metadata. `operation list --kind Update --status Failed` filters administrative history. `daemon status` advertises capabilities, limits and readiness. `doctor` reports storage/queue/permission findings without repairs. `daemon stop` persists a receipt, closes admission and waits for process exit; old-instance retries cannot stop a replacement. Unfinished asynchronous cleanup gets a two-second process fallback after the requested grace period.

[Offline backup and restore](docs/backup-restore.md) preserve source, durable state, blobs, bundles, extension cache and trust decisions. Destinations must be new directories. The test restores a waiting workflow at a different path after deleting its original repository.

## Typed run tags

Define metadata with Effect Schema and read it through Effect DI:

```ts
import { Tag } from "@offtree/effectory-sdk";
import { Effect, Option, Schema } from "effect";

const Team = Tag.make("team", Schema.NonEmptyString);
const Build = Tag.make("build", Schema.Int);

// Workflow.make spec: tags: [Team("platform"), Build]
// Build is optional; supplied values are validated before execution.
const readMetadata = Effect.gen(function* () {
  const team = Option.getOrElse(yield* Team.value(), () => "unassigned");
  const build = yield* Build.value(); // Option<number>
  return { team, build };
});
```

Tasks provide `Tag.Values` automatically. Tag-reading Layers belong on `Task.provide`, with resources scoped to that invocation. Standalone Effects can use `Effect.provideService(Tag.Values, { team: "platform" })`. `Task.test` accepts `tags: [Team("platform"), Build(42)]`.

```sh
effectory workflow run reporting --input null --tag build=042 --tag deployment=deploy-42
effectory run list --tag team=platform --tag deployment=deploy-42
```

Run tags persist through restart and appear on get/list/watch. Published artifacts inherit them; explicit publication tags override inherited values. Filters use indexed SQL and require every tag to match. See the [runnable example](examples/tagged/effectory.ts) and [full tag API](docs/run-tags-contract.md) for declarations, schedule overrides, limits, compatibility and Layer ownership.

## Artifact storage

Tasks publish schema-backed JSON through a runner-provided Effect service:

```ts
const publishReport = Effect.gen(function* () {
  const storage = yield* ArtifactStorage;
  return yield* storage.publish(Report, report, {
    key: "daily-report",
    tags: [Team("platform")],
  });
});
```

Use this inside an `Effect.gen` handler or task-local Layer, importing `ArtifactStorage` from `@offtree/effectory-sdk`. `Report` is an `Artifact.make` definition listed in the task's `outputs`; it determines the value and reference types. The runner checks output membership at runtime. Publication is available during Layer setup and the handler, and closes before task-local Layer finalizers. `Task.test` records publications automatically. Existing JSON `context.publish` remains a compatibility adapter.

See the [complete authoring example and lifetime contract](docs/artifact-storage.md).

Binary artifacts use the same service, with a `Uint8Array` or an Effect `Stream`:

```ts
const Csv = Artifact.make({
  id: "report/csv",
  version: 1,
  kind: "bytes",
  contentType: "text/csv",
  retention: { maxVersions: 3 },
});

const publishCsv = Effect.gen(function* () {
  const storage = yield* ArtifactStorage;
  return yield* storage.publish(
    Csv,
    Stream.make("name,count\n", "example,42\n").pipe(Stream.encodeText),
    { key: "summary" }
  );
});
```

Declare `Csv` in the task's `outputs`. The stream keeps its error and service requirements; map source errors to the task's declared error and provide source services through task-local Layers. See [binary artifact usage](docs/binary-artifacts.md) for a complete task and testing example.

```sh
effectory lake download <artifact-id> --version 1 --output ./report.csv
```

Downloads verify length and SHA-256 before installing the file and refuse to overwrite any destination. `LakeDownload` streams metadata and bytes through authenticated Effect RPC at `/rpc/content`; existing JSON RPC is unchanged. Binary content is capped at 16 MiB per publication, with four writers (additional writers wait) and four download producers (additional downloads fail `LimitExceeded`). There is no total-storage quota. Automatic policy collection is available through the default-off controls below. `lake get` remains the JSON reader.

## Artifact retention

Artifacts declare retention eligibility using Effect durations:

```ts
const Report = Artifact.make({
  id: "report",
  version: 1,
  schema: ReportSchema,
  retention: { maxVersions: 10, maxAge: "30 days" },
});
```

The newest retained version is always protected by an author policy. Older versions qualify when either limit is exceeded. A policy takes effect on an identity's next publication; a definition edit alone does not change stored policy. Collection stays manual unless the repository explicitly enables automatic retention.

Enable background use of these policies, inspect its status, or stop new automatic deletions:

```sh
effectory lake reclaim automatic enable
effectory lake reclaim automatic status
effectory lake reclaim automatic disable
```

Automatic retention is off by default. Enabling covers existing and future policy-eligible versions; newest versions and producer/consumer/report holds remain protected. Disable stops new automatic deletion decisions while already-committed blob cleanup can finish. The setting survives backup/restore. See [automatic retention](docs/automatic-artifact-retention.md) for timing, diagnostics, cursor expiry and recovery.

Preview a bounded plan, inspect its candidates and byte estimates, then apply its ID:

```sh
effectory lake reclaim plan --policy --schema report --json
effectory lake reclaim apply <plan-id> --json
effectory lake versions <artifact-id> --include-reclaimed --json
```

For daily keys or dormant data, use `lake reclaim plan --schema report --older-than "90 days"`. This operator selection can remove the final version; add `--keep-latest 2` to preserve two versions per identity. Exact removal uses `lake reclaim plan --artifact <artifact-id> --version 3`. Every mode protects unfinished producers, exact versions pinned by unfinished consumers, and publications with unsettled source reports.

Plans contain at most 1000 versions and expire after 15 minutes. Repeat preview/apply while `hasMore` is true. Retrying an applied plan ID returns its receipt, even after expiry, and resumes pending cleanup. Shared blobs are only removed after their final retained reference disappears, so logical bytes and reclaimed disk bytes can differ. Reclaimed metadata remains visible with `--include-reclaimed`, and affected pagination cursors expire.

These commands map to `LakeReclamationPlan` and `LakeReclamationApply`, gated by `lake.retention.v1`. See the [retention contract](docs/artifact-retention-api-draft.md) for policy capture, receipts, recovery and reference limitations. Reclamation does not trace references embedded in other run results, collect run history or sweep orphan blobs. The same policies and commands apply to JSON and binary artifacts.

## Reading artifacts in tasks

Yield `ArtifactReader` to read typed JSON, stream or verify bytes, inspect metadata, resolve latest-by-task/output/key, or query the lake. `ArtifactQuery.stream` traverses query pages. Tasks declare `ArtifactReadError` and `ArtifactUnavailable` in their error schema; the latter can opt into retries.

The first exact read protects an external version for the consumer run (up to 1,024 distinct versions). Unsettled reports protect their source publications. Query rows and unaccessed input references are not pins. All binary publishers and readers share invocation admission, so long reads can delay writes while copy pipelines avoid read/write deadlocks.

`Artifact.fixture` and `Task.test({ artifacts })` support producer/consumer handoffs; `Report.test` accepts the same fixtures. See [reader usage and lifetime rules](docs/artifact-reads.md), the [complete example](examples/artifact-reads/effectory.ts), and the [approved contract](docs/artifact-reads-api-draft.md).

## Installing as a binary

The CLI, daemon and runtime compile to one standalone executable that includes Bun, `effect` and `@offtree/effectory-sdk`. Projects install the npm SDK only for types; the binary supplies the runtime copies, so a project does not need Bun or a `node_modules` folder to run.

```sh
curl -fsSL https://raw.githubusercontent.com/Rowenin/effectory/main/install.sh | sh
effectory init my-automation                # effectory.ts, tsconfig.json, version marker and SDK pins
cd my-automation
bun install                                 # authoring types from npm: @offtree/effectory-sdk and effect
effectory daemon start
effectory workflow run hello/run --input '{"name":"Ada"}'
effectory doctor sdk                        # project marker and SDK match the binary?
effectory upgrade                           # after installing a new binary: re-pin, then reinstall
```

Binaries are attached to [GitHub Releases](https://github.com/Rowenin/effectory/releases) for macOS and Linux (arm64 and x64, glibc and musl). To build one from source, run `bun run build:binary` (output in `dist/bin/`).

See [binary distribution](docs/binary-distribution.md) for how the host provides its modules, ABI compatibility and the project version commands.

## Mapping to Swamp

| Effectory authoring API | Closest Swamp equivalent |
| --- | --- |
| `Task.make(...)` | A behavior method contract |
| Second argument to `Task.make(spec, handler)` | The method implementation |
| `TaskGroup.make(...)` (proposed) | The method collection of a behavior type |
| Application services supplied through Layers | Configured behavior arguments, partially; a named definition API is still needed |
| `graph.task("greeting", Greet, input)` | A workflow step invoking a behavior method |
| `Workflow.make(...)` | A workflow definition |
| `WorkflowSchedule.make(...)` | A workflow schedule |
| A submitted workflow / task run | A workflow run / method run |
| `Artifact.make(...)` / `storage.publish(...)` on the yielded `ArtifactStorage` | A resource output specification / versioned resource write |
| `Artifact.make({ kind: "bytes", ... })` / `storage.publish(...)` | A file output specification / file writer |
| An extension | A package of behavior types, workflows and providers |

A task is reusable; a step is one invocation of it. Small pure transformations do not need to be separately recorded tasks. The Swamp behavior type → configured definition → method relationship is not fully represented by TaskGroup alone.

## API and runner design

The [selected authoring model](docs/authoring-runtime.md) uses an explicit graph builder with Effect-based construction. The [five API alternatives](docs/authoring-api-options.md) record the earlier exploration. [Claude’s developer-experience review](docs/authoring-api-review-claude.md) and the [review follow-up](docs/authoring-api-options.md#review-follow-up) document the recommendations and remaining questions.

- [Authoring APIs](docs/authoring-runtime.md): task contracts, Layers, typed contexts, graph construction, execution boundaries and open type-design work.
- [Customer application and edge runner](docs/edge-runtime.md): entry point, implementations, dependency provision, discovery, loading and execution.
- [Pausing and input](docs/pausing-and-input.md): proposals for approval gates, typed user input and external signals, grounded in Swamp’s behavior.
- [CLI commands and server RPCs](docs/cli-server-api.md): command-to-RPC mapping, request/response contracts, durable runs and waits, lake queries and extensions.
- [Implementation readiness](docs/implementation-roadmap.md): five sequential planning passes, proposed API refinements, proof gates and first-release scope.
- [Using extension tasks](docs/extension-task-consumption.md): install, typed import, local workflow composition and application registration.
- [Binary distribution](docs/binary-distribution.md): compiled host, built-in `effect`/SDK modules, ABI and SDK version alignment.
- [Full design](docs/README.md): Swamp analysis, extensions, persistence, queries and delivery plan.

Upstream source is available locally in `vendor/swamp` and `vendor/effect`. See [source references](vendor/README.md) for pinned revisions and restoration.

## Assertions and JUnit

Tasks can `yield* Checks` and call `checks.assert(id, predicateEffect, { message, severity? })`. Declare `AssertionFailed` in the task's error schema. Assertions are recorded per attempt and entry, survive restart, and are available through `run checks` and `run junit`.

```sh
effectory workflow run deploy --input-file deployment.json --junit --output results.xml
```

False assertions remain failures in JUnit even when a higher `--fail-on` threshold lets execution continue. Export requires a completed run and refuses to overwrite files. See [checks and CI usage](docs/workflow-checks.md).

## Repository checks

```sh
bun run typecheck && bun run check && bun test
```

The workspace installs successfully with Effect 4.0.5. Core type fixtures and process-level persistence tests are available. Process tests cover the CLI example across daemon death, changed application source, durable approval and artifact publication. The broader design catalogue still contains unimplemented proposals.

## License

[MIT](LICENSE)

## Vaults

Secrets are typed Effect services with provider Layers. Define logical names using `Vault.make`, read `yield* Credentials.get("token")`, and select local storage or an extension read provider using `Vault.layer(Credentials, provider)`. Different vaults can use different providers in the same task. Tasks declare `Vault.Errors`; values are returned as `Redacted`.

Local storage encrypts values and keeps root keys outside the repository. CLI commands cover inspection, version-checked writes/deletion, explicit reveal and offline key recovery/reset. Remote providers are read-only in this slice. Managed task outputs and telemetry have bounded accidental-disclosure guards; binary contents and arbitrary external I/O are excluded.

See [vault authoring and operations](docs/vaults.md) and the [two-provider example](examples/vaults/effectory.ts).

## Run reports

Reports turn a completed task or workflow into Markdown and structured data. A reporter is an ordinary task; it gets its source identity as input and yields `Report.History` to inspect the outcome. Attach it separately so reporting failures never change the source run's result. See the complete [reports example](examples/reports/effectory.ts).

```ts
const Summary = Task.make(
  {
    id: "greeting-summary",
    version: 1,
    input: Report.sourceOf(Greet),
    success: Report.result(Schema.String),
    error: Schema.Never,
    replay: "idempotent",
  },
  () =>
    Effect.gen(function* () {
      const history = yield* Report.History;
      const outcome = yield* history.outcome(Greet);
      const text =
        outcome._tag === "Succeeded" ? outcome.value : "Greeting failed";
      return { markdown: `# Greeting\n\n${text}\n`, data: text };
    })
);

export default Application.make({
  tasks: [Greet, Summary],
  reports: [
    Report.make({
      id: "greeting-summary",
      target: Greet,
      task: Summary,
      scope: "run",
    }),
  ],
});
```

Import `Report` alongside the other SDK namespaces. The snippet uses `Greet` from the first example. Use `scope: "invocation"` to report on each completed use of a task inside a workflow, including fan-out items. A directly submitted task matches both scopes. Workflow targets also support invocation scope: each actual child execution reports independently, and direct workflow submissions match both scopes. Their History is child-scoped. See [workflow invocation reports](docs/workflow-invocation-reports.md). Reports run for success, failure, cancellation, rejection and timeout by default; `on` narrows those outcomes. A task that never started gets a NotApplicable report record.

```sh
effectory report search cost --workflow deploy --tag team=platform
effectory report list <source-run-id>
effectory report wait <source-run-id>
effectory report wait --report <report-id>
effectory report get <report-id>
effectory report get <report-id> --data
effectory report get <report-id> --output summary.md
effectory report retry <report-id> --request-key retry-1
effectory report cancel <report-id>
effectory report cancel --run <source-run-id>
effectory run summary <source-run-id>
effectory run list --origin report
```

[Report selection](docs/report-selection.md) supports `--report`, `--report-tag`, `--skip-report`, `--skip-report-tag`, and `--skip-reports` on task/workflow submissions. Attachment classification uses typed tags; `required: true` survives selection filters, including skip-all. Scheduled workflows accept `reportSelection`. The decision is captured in `run get`; excluded attachments create no report obligations.

[`report search`](docs/report-search.md) finds report records across runs, including those that never started. It defaults to latest generations excluding NotApplicable, supports repeated statuses and source tags, and prints complete continuation commands. Follow cursors even for empty pages; statuses remain live. Search itself exits 0 regardless of matching report outcomes.

`report get` writes Markdown by default, `--data` selects structured JSON, and `--json` returns the full record and content. Output files are created exclusively; an existing file is never overwritten. Piped Markdown preserves its bytes; terminal output escapes unsafe controls while preserving newlines and tabs. Reports have a 256 KiB Markdown limit and a 1 MiB total result limit.

Foreground runs keep their source exit codes and print a report-list hint. `report wait` follows the source through timers/retries, returning 4 when outside action is available; after the source finishes it waits for the latest report generations. A single-report wait can finish while the parent is waiting for approval. Report commands use exit 0 for success/NotApplicable, 1 for failed or cancelled reports, and 4 for pending work or operator attention. Aggregate waiting gives operator attention precedence over failure.

Retries keep the original source, revision and execution policy. Default report limits are four admitted/executing runs, a five-minute execution timeout and a 30-second attempt timeout. Queue time before dispatch is excluded. Report runs appear in ordinary history, inherit source tags, and do not recursively trigger reports. Task-local Layers can use `Report.History`; its readers close with the attempt. `Report.test` supplies fixture history for isolated tests; an ordinary manual task run has no source history.

Bulk cancellation fixes the selection at acceptance and survives restart. Later invocations and explicit retries remain eligible; cancel the source first to stop future source work. Lists default to latest generations; `--history` includes earlier ones. Results and mutation receipts are currently unpruned. Lake publication is explicit through `ArtifactStorage`. Child-workflow boundary reports and automatic report retention remain parity gaps. The [report contract](docs/run-reports-api-draft.md) records the full behavior and limits.

## Completed run-history reclamation

`run reclaim plan|apply|inspect|compact` provides explicit offline maintenance. Plans select whole completed source/report families; apply removes detailed and native workflow history while keeping permanent submission records. Artifacts and unfinished consumer protection remain intact. Repeating a retired submission key or mutation returns Conflict, detailed reads return NotFound with an inspect hint, and old history cursors expire.

Stop the daemon before maintenance. Pending work recovers before startup; backup refuses until recovery completes. This adds no RPC or SDK service. See [operator usage](docs/run-history-retention.md) and [verification](docs/run-history-retention-implementation.md).

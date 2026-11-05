# Effectory

An Effect-native TypeScript automation library with a durable graph runner, authenticated local RPC daemon, CLI, GitHub extensions and queryable JSON artifact lake. The bounded v0 implementation passes its local checks and live public/private GitHub extension installation and offline restore checks; see [implementation status](docs/implementation-status.md) and the [release checklist](docs/release-checklist.md).

## The customer API

Define tasks and workflows, then export an application from `effectory.ts`. The runner loads that application. Files can be organized however you prefer; ordinary TypeScript imports determine what belongs to the application.

```ts
import { Application, Task, Workflow } from "@effectory/core";
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
import { WorkflowSchedule } from "@effectory/core";

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

The daemon stores state under the selected repository's `.effectory/`, binds to authenticated loopback HTTP, and holds exclusive repository ownership. A background command returns after durable acceptance. Invalid inputs are rejected before handlers run. `run watch` uses a bounded RPC stream. It prints the final run by default; add `--jsonl` for snapshot, ordered event and heartbeat frames. Resume JSON Lines observation with `--after-sequence <last-event-sequence>`. Snapshot `lastSequence` is the current projection and may be ahead of replayed events: only advance a consumer checkpoint after processing an Event frame. Disconnecting observation does not cancel execution.

Inspection commands return pages with `items`, `cursor` and `snapshot`. Repeat filters and `--limit` when supplying `--cursor`:

```sh
bun run effectory run list --status Waiting --limit 20 --json
bun run effectory run waits --kind approval --json
bun run effectory run events <run-id> --limit 50 --json
bun run effectory run logs <run-id> --level Warn --json
bun run effectory run outputs <run-id> --json
bun run effectory run cancel <run-id> --reason 'No longer needed' --request-key stop-1 --json
```

`run waits` defaults to open waits; use `--status all` for settled interactions, and `run wait <wait-id>` for context, response schema and payload. Event cursors pin an immutable sequence range. Run, wait and task-output pages exclude later admissions but show current status/results for the original members. Definition discovery cursors retain the application revision even during activation. Cursors expire after one hour.

Ordinary `Effect.log*` calls inside task handlers are captured with node and attempt identity. Logs and `context.progress` are best effort, sharing a persistent 1,000-entry / 1 MiB budget per run and an 8 KiB entry limit. One `TelemetryTruncated` event records exhaustion; control events remain available. Log values that cannot fit bounded JSON are replaced with an omission marker. These limits do not sandbox privileged application code or capture direct `console.log` calls. `run outputs` reads the native Effect task outcomes without executing handlers; artifact publications remain queryable through the lake.

The lake supports `And`, `Or`, `Not`, `Eq`, `Gt`, `Gte`, `Lt`, `Lte` and `In`, using metadata, tags and declared JSON fields. Optional `select: [{ name, field }]` adds named values to each row's `projection`; provenance metadata remains present. `orderBy: [{ field, direction: "asc" | "desc" }]` uses artifact ID/version to break ties. Range and ordered fields must have one encoded string or numeric type, optionally nullable. Use `Schema.Finite` for numeric query fields. Missing comparisons are false, null matches null, and missing projected fields are omitted. Cursors retain their original commit snapshot and latest-as-of versions.

`lake versions <artifact-id>` pages exact version metadata. `operation list --kind Update --status Failed` filters administrative history. `daemon status` advertises capabilities, limits and readiness. `doctor` reports storage/queue/permission findings without repairs. `daemon stop` persists a receipt, closes admission and waits for process exit; old-instance retries cannot stop a replacement. Unfinished asynchronous cleanup gets a two-second process fallback after the requested grace period.

[Offline backup and restore](docs/backup-restore.md) preserve source, durable state, blobs, bundles, extension cache and trust decisions. Destinations must be new directories. The test restores a waiting workflow at a different path after deleting its original repository.

## Installing as a binary

The CLI, daemon and runtime compile to one standalone executable that includes Bun, `effect` and `@effectory/core`. Projects install the npm SDK only for types; the binary supplies the runtime copies, so a project does not need Bun or a `node_modules` folder to run.

```sh
bun run build:binary                        # dist/bin/effectory-<platform>
effectory init my-automation                # effectory.ts, tsconfig.json, version marker and SDK pins
cd my-automation
bun install                                 # authoring types; needs @effectory/core on npm (not yet published)
effectory daemon start
effectory workflow run hello/run --input '{"name":"Ada"}'
effectory doctor sdk                        # project marker and SDK match the binary?
effectory upgrade                           # after installing a new binary: re-pin, then reinstall
```

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
| `Artifact.make(...)` / `context.publish(...)` | A resource output specification / versioned resource write |
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

## Checks

```sh
bun run typecheck && bun run check && bun test
```

The workspace installs successfully with Effect 4.0.5. Core type fixtures and process-level persistence tests are available. Process tests cover the CLI example across daemon death, changed application source, durable approval and artifact publication. The broader design catalogue still contains unimplemented proposals.

# CLI commands and server RPCs

This catalogue describes the implemented bounded v0 CLI/server surface, with broader follow-ups called out explicitly. See [implementation status](implementation-status.md) and the [release checklist](release-checklist.md) for local and live distribution evidence. The [earlier library/MCP catalogue](control-plane-api.md) is exploratory; its adapter APIs are outside this pass. Exact RPC tags below supersede its provisional RPC family names. [Daemon and RPC](daemon-rpc.md) covers transport, process ownership and restart behavior.

The CLI is a client of the daemon. Every server operation has a named Effect RPC with Effect Schema request, success and error contracts. Formatting, file input and foreground observation are CLI conveniences around those RPCs. A background run and a foreground run use exactly the same submission method.

The implemented extension RPCs are `ExtensionAdd`, `ExtensionUpdate`, `ExtensionRemove`, `ExtensionList`, `ExtensionDescribe`, `OperationGet` and `OperationList`. Add/update requests include a Boolean `trust`; source selectors are `{ repository, ref, assetName }`. The CLI parses `github:owner/repo@tag` into that selector. Inventory currently returns all packages (bounded to 128) with installed/application revisions. Operation listing uses signed `cursor` pages, optional initial `afterSequence`, `kind`/`status` filters and `limit` (maximum 200), and receipts include both resulting revisions. `SystemHello` and `SystemStatus` expose `installedRegistryRevision` separately from the active `revision`. `ExtensionOutdated` reads latest-release metadata in pages of at most 20 roots using `afterId` and an unchanged `revision`; the CLI exposes `--after`, `--revision` and `--limit`. It reports tag differences without claiming semantic-version ordering or installing anything. The executable schemas in `packages/runtime/src/rpc.ts` are authoritative for the wire format.

## Discovery and execution

All commands below start with `effectory`. Payloads use TypeScript-like notation to describe fields, not executable schema definitions. `?` means optional. `page` expands to optional `limit` and `cursor`; `key` expands to required `requestKey`. These are documentation abbreviations, not nested wire fields.

| CLI command | Server RPC tag | Request payload | Success |
| --- | --- | --- | --- |
| `task list` | `TaskList` | `{ search?, namespace?, revision?, ...page }` | `Page<TaskSummary>` |
| `task describe <id>` | `TaskDescribe` | `{ id, revision? }` | `TaskDescription` |
| `task validate <id> --input <json>` | `TaskValidate` | `{ id, revision?, input }` | `ValidationResult` |
| `task run <id> --input <json>` | `TaskRun` | `{ id, revision?, input, ...key }` | `RunAccepted` |
| `workflow list` | `WorkflowList` | `{ search?, namespace?, revision?, ...page }` | `Page<WorkflowSummary>` |
| `workflow describe <id>` | `WorkflowDescribe` | `{ id, revision? }` | `WorkflowDescription` |
| `workflow validate <id> --input <json>` | `WorkflowValidate` | `{ id, revision?, input }` | `ValidationResult` |
| `workflow plan <id> --input <json>` | `WorkflowPlan` | `{ id, revision?, input }` | `WorkflowPlan` |
| `workflow run <id> --input <json>` | `WorkflowRun` | `{ id, revision?, input, ...key }` | `RunAccepted` |

IDs come from registered Task/Workflow specs. `revision` identifies the immutable application bundle and provider selection, not the spec's numeric schema version. Descriptions expose input/success/error JSON Schemas, replay policy where relevant, provider provenance and allowed operations. Lists and descriptions identify the resolved revision so callers can pin subsequent requests.

Validation checks the definition and supplied encoded input without executing handlers. A schema mismatch returns `{ valid: false, issues, revision }`; a missing definition or inaccessible revision is an RPC error. Submission always validates again. `plan` returns the graph, dependencies, wait kinds, policies and extension patches. Runtime-dependent branches/results remain explicitly unresolved. It inspects the validated graph built during application loading; it does not run arbitrary customer source in the CLI or execute tasks as a dry run.

`TaskRun` and `WorkflowRun` share one internal submission service and return the same receipt. There is no additional public `RunSubmit` alias. Both return after durable acceptance; watching is a separate RPC. Omitting revision selects the active revision once at acceptance. Retrying the same request key returns that original run, even after the active revision changes.

## Run history and control

| CLI command | Server RPC tag | Request payload | Success |
| --- | --- | --- | --- |
| `run list` | `RunList` | `{ targetId?, kind?, status?, createdAfter?, createdBefore?, ...page }` | `Page<RunSummary>` |
| `run get <run-id>` | `RunGet` | `{ runId }` | `RunSnapshot` |
| `run events <run-id>` | `RunEvents` | `{ runId, afterSequence?, ...page }` | `Page<RunEvent>` |
| `run watch <run-id>` | `RunWatch` | `{ runId, afterSequence? }` | Stream of `RunWatchFrame` |
| `run logs <run-id>` | `RunLogs` | `{ runId, nodeId?, level?, ...page }` | `Page<LogEntry>` |
| `run outputs <run-id>` | `RunOutputs` | `{ runId, nodeId?, ...page }` | `Page<RunOutput>` |
| `run cancel <run-id>` | `RunCancel` | `{ runId, reason?, ...key }` | `CancellationReceipt` |

`RunSnapshot` contains target/revision, status, acceptance time, last event sequence and bounded input/result/error values. Progress and attempt history are available through events/logs; waits have a separate paged endpoint. Outputs identify task/node, current native completion state and either bounded encoded values or lake references. A failed run is data in a successful `RunGet`, not an RPC failure.

Cancellation records intent and may return `Cancelling`; it cannot undo prior external effects. Cancelling an already-terminal run returns its existing state. There is no ordinary resume RPC after a wait answer. Recovery from `NeedsAttention` requires a future reconciliation contract; it must not blindly retry an uncertain external side effect. A new run of a terminal workflow uses a new submission key.

## Approvals, input and signals

| CLI command | Server RPC tag | Request payload | Success |
| --- | --- | --- | --- |
| `run waits [run-id]` | `WaitList` | `{ runId?, kind?, status?, ...page }` | `Page<WaitSummary>` |
| `run wait <wait-id>` | `WaitGet` | `{ waitId }` | `WaitDescription` |
| `run approve <wait-id>` | `WaitApprove` | `{ waitId, ...key }` | `WaitReceipt` |
| `run reject <wait-id> --reason <text>` | `WaitReject` | `{ waitId, reason?, ...key }` | `WaitReceipt` |
| `run respond <wait-id> --input <json>` | `WaitRespond` | `{ waitId, input, ...key }` | `WaitReceipt` |
| `run signal <wait-id> --payload <json>` | `WaitSignal` | `{ waitId, payload, ...key }` | `WaitReceipt` |

Wait listing defaults to open waits. Lists return run/node identity, kind, deadline, state and prompt. `WaitGet` adds authorized context/schema/payload metadata. The wait kind and current state determine which answer operation is applicable. Runtime wait IDs identify opened interactions and are distinct from graph node IDs. The server derives actor identity from authentication. Invalid data leaves the wait open; answering through the wrong operation returns `WrongWaitKind`.

A receipt confirms durable settlement and continuation intent. The scheduler automatically resumes eligible nodes. It does not mean downstream work has finished. Signals require an already-open exact wait ID; unregistered early delivery is rejected. Graph-level register-before-trigger is implemented with a single await consumer. See the [interaction contract](pausing-and-input.md#shared-operator-and-rpc-contract) for deadlines, duplicate delivery and answer/timeout/cancellation races.

## Lake and extensions

| CLI command | Server RPC tag | Request payload | Success |
| --- | --- | --- | --- |
| `lake query --file <query.json>` | `LakeQuery` | `{ query, cursor? }` | `QueryPage` |
| `lake get <artifact-id> --version <n>` | `LakeGet` | `{ artifactId, version }` | `ArtifactDescription` |
| `lake versions <artifact-id>` | `LakeVersions` | `{ artifactId, ...page }` | `Page<ArtifactVersion>` |
| `extension list` | `ExtensionList` | `{}` | `ExtensionInventory` (at most 128 packages) |
| `extension describe <id>` | `ExtensionDescribe` | `{ id }` | `ExtensionDescription` |
| `extension add <github-source> [--as <name>]` | `ExtensionAdd` | `{ source, bindingName?, trust, expectedRevision, ...key }` | `OperationAccepted` |
| `extension update <id> --to <ref>` | `ExtensionUpdate` | `{ id, ref, trust, expectedRevision, ...key }` | `OperationAccepted` |
| `extension remove <id>` | `ExtensionRemove` | `{ id, expectedRevision, ...key }` | `OperationAccepted` |
| `extension outdated` | `ExtensionOutdated` | `{ revision?, afterId?, limit? }` | `{ items, revision, nextAfterId }` |
| `operation get <operation-id>` | `OperationGet` | `{ operationId }` | `OperationSnapshot` |
| `operation list` | `OperationList` | `{ kind?, status?, ...page }` | `Page<OperationSummary>` |

Lake queries use the versioned [query AST](data-lake.md#query-boundary), with bounded execution and snapshot pagination. Exact-version reads return metadata and bounded JSON content. V0 supports bounded JSON content only. Binary streams, `--output`, expiration and automatic retention/GC are deferred; unavailable or corrupt retained content is a storage error.

Extension mutations are persisted administrative operations. Receipts contain operation ID, kind, acceptance time, request key and current status. `OperationSnapshot` has Queued/Running/Succeeded/Failed status, progress, timestamps and final revision or structured failure. Inspecting failure is a successful status read. Activation follows the [extension contract](extensions.md#installation-and-activation); existing runs keep their original bundles. `outdated` only checks availability.

The [typed extension consumption proposal](extension-task-consumption.md) adds optional `bindingName` for generating an import in `effectory.extensions.ts`. Validate the identifier and collisions before committing; include it in mutation fingerprints. Updates preserve the configured name and regenerate matching bindings. Installed package descriptions expose binding names; operation results report the resulting registry/application revisions. Report success only when the installed snapshot and generated contracts agree.

The CLI accepts `--expected-revision`; when omitted, it reads `SystemStatus` once before creating the mutation request and reuses that revision on transport retries. A registry conflict is shown to the caller, not silently retried with a fresh revision. Extension commands return the operation receipt; `operation get` exposes progress without holding the installation RPC open.

## Daemon and local commands

| CLI command | Server RPC tag | Request payload | Success |
| --- | --- | --- | --- |
| Automatic on connect | `SystemHello` | `{ repositoryId, protocolMajor, clientVersion }` | `ServerHello` |
| `daemon status` | `SystemStatus` | `{}` | `SystemStatus` |
| `daemon stop` | `SystemDrain` | `{ instanceId, gracePeriodMs, ...key }` | `DrainReceipt` |
| `doctor` | `SystemDoctor` | `{}` | `DiagnosticReport` |

Hello establishes protocol compatibility and repository identity in addition to transport authentication. Its response advertises server version, instance ID, capabilities and limits. Status includes readiness, active application/registry revisions and drain state. Doctor reports findings without performing repairs.

`daemon start` creates the process locally and waits for readiness; it cannot be an RPC to a process that does not exist. `daemon stop` requests a bounded drain, then observes that instance exiting. A drain receipt acknowledges the request, not completed shutdown. The instance ID prevents a retried stop from draining a replacement process. Interrupted work follows restart recovery; stopping the daemon does not mark every durable run Cancelled.

`extension restore` is the local bootstrap command: before loading the application, acquire the exclusive repository lock, materialize the already-locked packages and regenerate typed imports. It verifies exact recorded digests, never updates refs/selections, and requires no running daemon. Refuse it while another process owns the repository. No new server RPC is needed for this bootstrap path; running-daemon extension mutations already maintain their bindings.

Help is provided by the CLI framework. `init` and source-watching `dev` are deferred local conveniences. `backup` and `restore` are implemented local offline operations; see [the procedure](backup-restore.md). The daemon host owns application loading/reloading; these methods do not add an RPC for evaluating arbitrary source or editing customer files.

## Shared boundary rules

- IDs and revisions are opaque validated strings. Times are UTC timestamps; versions and event sequences are bounded integers. Dynamic inputs are encoded JSON, then decoded by the selected definition's pinned Effect codec.
- Lists default to 50 entries with a maximum of 200. Opaque cursors bind filters, authorization scope and the relevant snapshot; expiry is explicit. Clients repeating a cursor repeat the same filters. For events, a cursor and an initial `afterSequence` are mutually exclusive. Lake queries retain their own AST limit.
- `RunAccepted` contains `runId`, target kind/ID, pinned revision, acceptance time, `requestKey` and current status. Acceptance commits both the run and dispatch intent; it does not assert execution success.
- `WaitReceipt` contains wait/run IDs, settled outcome, actor, settlement time, `requestKey` and continuation state. `CancellationReceipt` contains run ID, `requestKey` and current status. `DrainReceipt` contains instance ID, request key, drain status and deadline. Mutation receipts retain enough identity for retries.
- RPC methods share the Schema-tagged `OperationError` boundary, including `InvalidInput`, `NotFound`, `Unauthorized`, `Conflict`, `RevisionUnavailable`, `Unavailable` and `CursorExpired`. Wait methods also use `WrongWaitKind` and `WaitClosed`; Transport authentication rejects incorrect repository/protocol headers before dispatch. Errors return bounded safe messages; arbitrary defects and secrets are not serialized. Dedicated handshake error variants and correlation IDs remain future work.
- All mutations require a request key. Reads still require authorization. Duplicate lookup never bypasses access checks. Submission keys fingerprint the supplied revision selector separately from the resolved revision. Extension keys fingerprint action, source and expected revision; duplicate lookup precedes checking a consumed expected revision. Wait keys follow the wait contract.

## Effect RPC declarations

This illustrates the declaration shape against the pinned Effect source. Names such as `WorkflowRunRequest` stand for proposed Effectory schemas described above; this is not a complete executable module or a typechecked implementation.

```ts
import { Rpc, RpcGroup } from "effect/rpc";

const ControlPlaneRpcs = RpcGroup.make(
  Rpc.make("WorkflowRun", {
    payload: WorkflowRunRequest,
    success: RunAccepted,
    error: SubmitError,
  }),
  Rpc.make("RunWatch", {
    payload: RunWatchRequest,
    success: RunEvent,
    error: WatchError,
    stream: true,
  }),
  Rpc.make("WaitRespond", {
    payload: WaitRespondRequest,
    success: WaitReceipt,
    error: WaitSettlementError,
  })
);

// ControlPlaneRpcs.toLayer({ WorkflowRun: ..., RunWatch: ..., WaitRespond: ... })
// supplies handlers that delegate to application services.
```

See the pinned [Rpc.make](../vendor/effect/packages/effect/src/rpc/Rpc.ts) and [RPC tests](../vendor/effect/packages/effect/test/rpc/Rpc.test.ts). The full group contains every server tag in the catalogue. CLI flag parsers translate into these schema-defined payloads; the daemon validates independently.

## CLI conventions and one complete interaction

`--repository` selects the local daemon before connecting. `--revision` pins definition operations. List filters map to kebab-case flags such as `--target-id`, `--created-after` and `--after-sequence`. `--limit` and `--cursor` control paging. `--input-file` is an alternative to `--input`, and `--input-file -` reads stdin. Signals have equivalent `--payload` / `--payload-file` flags. The CLI parses JSON before sending it; the server receives values, never caller-local file paths.

The CLI creates a request key before each mutation and preserves it for transport retries. `--request-key` supplies a stable key across CLI invocations. Keys appear in receipts and uncertain-delivery diagnostics. Launching a new command without that flag creates a new intent. JSON mode writes structured results to stdout; diagnostics go to stderr. `run watch --jsonl` emits JSON Lines; `--json` emits the final snapshot as one JSON value. Each JSON-Line write completes before the next frame is pulled or its resume checkpoint advances.

```sh
effectory workflow describe release-summary --json
effectory workflow run release-summary --input '{"repository":"swamp-club/swamp"}' \
  --request-key release-42 --background --json
effectory run waits <returned-run-id> --json
effectory run approve <returned-wait-id> --request-key review-42 --json
effectory run watch <returned-run-id>
```

The RPC sequence is `WorkflowDescribe`, `WorkflowRun`, `WaitList`, `WaitApprove`, then `RunWatch`, each after connection authentication/handshake. `WaitList` may initially be empty if the run has not reached the gate; inspect events or list again later. There is no need to keep the submitting process alive.

Without `--background`, run commands observe until terminal or fully Waiting. On Waiting or NeedsAttention, print the run snapshot and exit 4; use `run waits <run-id>` to inspect interactions. Explicit `run watch` stays attached through waits. Both observation modes use snapshot plus event cursor so a fast completion cannot fall between submission and subscription. Watch defaults to sequence zero; resume with the last observed sequence. V0 retains event history; an invalid or future sequence is rejected. Paged inspection cursors expire after one hour. Ctrl-C stops observation; only `RunCancel` requests execution cancellation.

Exit codes: 0 for accepted background work, successful reads or successful completion; 1 for unsuccessful terminal outcomes; 2 for invalid arguments/schema input; 3 for unavailable daemon/transport; 4 for foreground Waiting; 5 for authorization/state conflicts; 130 for interrupted observation. Validation with `valid: false` exits 2. An unresolved delivery reports uncertainty and its key, not proof that no run was accepted.

## Swamp baseline mapping and remaining work

| Swamp surface | Proposed CLI/server equivalent |
| --- | --- |
| `behavior type search/describe`, `behavior run` | Task discovery and `TaskRun`; named configured behavior instances remain a gap |
| `workflow search/get/schema/validate/evaluate/run` | Workflow discovery, validation, planning and `WorkflowRun` |
| Behavior/workflow history, logs and outputs | Unified `RunList/Get/Logs/Outputs` |
| `workflow approvals/waits/approve/reject/signal` | `WaitList/Get/Approve/Reject/Respond/Signal` |
| `data query/get/versions` | `LakeQuery/Get/Versions` |
| Extension install/update/remove | GitHub `ExtensionAdd/Update/Remove` and operation inspection |
| Serving/status and diagnostics | Local process commands plus `SystemHello/Status/Drain/Doctor` |

Evidence comes from the [pinned Swamp checkout](../vendor/README.md): [behavior](../vendor/swamp/src/cli/commands/behavior.ts), [workflow](../vendor/swamp/src/cli/commands/workflow.ts), [data](../vendor/swamp/src/cli/commands/data.ts) and [extensions](../vendor/swamp/src/cli/commands/extension.ts).

This covers the initial execution/data/extension baseline, not every Swamp command. Vault administration, webhook triggers, uncertain-effect recovery, retention/GC, reports/access management and remote workers still need dedicated contracts. Durable workflow schedules are now implemented under the approved contract below. Authoring CRUD is TypeScript editing plus application reload; it is not a server source-editing API. MCP and a public client SDK can adapt these contracts in a separate pass without redefining run or wait semantics.

Concrete schemas, payload limits and the trusted local-owner authorization model are implemented. Lost-response retries, restart recovery, snapshot/watch handoff, paging, wait settlement races and bounded draining have executable tests in the [release checklist](release-checklist.md).

## Implemented inspection surface

The runtime schemas in `packages/runtime/src/history-protocol.ts` define the current wire shapes. `TaskList` and `WorkflowList` return `{ items, cursor, revision }`; `RunList`, `RunEvents`, `WaitList`, `RunLogs` and `RunOutputs` return `{ items, cursor, snapshot }`. Cursors expire after one hour, bind principal and filters, and require repeating the original limit. Run/wait/output membership excludes later admissions, while returned status and output availability are current projections. Event/log snapshots are sequence high-water marks.

`WaitList` returns compact summaries and defaults to Open; `status: "all"` includes settled waits. `WaitGet` returns the full context/schema/payload. Prompt, context and schema limits are 8 KiB, 64 KiB and 64 KiB respectively. `RunOutputs` reads native Effect task results, including Pending/Suspended states and typed failure outcomes. It does not repeat handlers or create a host task-result journal. Artifact metadata is inspected through the lake.

`RunWatch` is an Effect RPC stream of Snapshot, Event and Heartbeat frames, capped at 16 observers, 16 events per read and four buffered RPC chunks. It replays from `afterSequence` and closes only after terminal history has been delivered. Snapshots show the current projection and can precede older replayed events. Checkpoint only delivered Event sequences. The CLI's `--jsonl` emits one frame per line and prints a resume command on transport failure; default watch prints the final run as one JSON value.

Task `Effect.log*` calls and context progress are best effort with a shared 1,000-entry / 1 MiB per-run budget, 8 KiB per entry, and one truncation event. Node and attempt identity are recorded. Logs do not capture direct console output or replace durable control events. Log filters use exact Effect level names such as `Warn`. General JSON boundaries are capped at 1 MiB, depth 64 and 100,000 values. Inspection event/wait/log pages cap item bytes at 1 MiB; task-output pages allow 2 MiB to accommodate a maximum-sized result plus metadata.

Daemon drain receipts are persisted against an exact instance and request key. Changed retries conflict; an identical old-instance retry returns its original receipt without draining the replacement. New admission closes after the receipt commits, while duplicate submissions still return their accepted runs. The CLI observes process exit after requesting drain. At grace expiry the daemon closes resources, with a two-second process fallback for asynchronous cleanup that will not settle. `SystemStatus` reports Ready/Draining and the current receipt. `doctor` inspects ownership, SQLite page metadata, bounded queue/wait counts, available disk space, credential permissions and best-effort telemetry failures. It does not repair files or perform an exhaustive integrity audit.

## Implemented workflow scheduling

The user-approved [scheduling contract](scheduling-api-draft.md) adds these schema-defined methods. The daemon must be running; application source owns schedule definitions.

| CLI | RPC | Result |
| --- | --- | --- |
| `schedule list [--workflow ID] [--state active\|blocked\|paused\|removed]` | `ScheduleList` | Paged current schedule summaries; removed identities excluded by default |
| `schedule get ID` | `ScheduleGet` | Summary, fixed encoded input, catch-up policy, revision and pause details |
| `schedule history ID` | `ScheduleHistory` | Paged admitted runs/current statuses and coalesced missed ranges |
| `schedule pause ID [--reason TEXT] [--request-key KEY]` | `SchedulePause` | Durable idempotent mutation receipt; accepted runs continue |
| `schedule resume ID [--request-key KEY]` | `ScheduleResume` | Durable receipt; next occurrence is strictly after resume time |

List/history accept `--limit` and `--cursor`. RPC payloads use `scheduleId`, `workflowId`, capitalized state literals, and required mutation request keys. CLI generates keys when omitted and prints a recovery key on uncertain delivery. Keys are scoped to schedule ID and actor; only the latest 256 receipts per schedule are retained. Reusing an evicted key is a new mutation.

`SystemHello` advertises `schedule.v1`; `SystemStatus.scheduler` reports scheduler state, reconciled revision, counts and diagnostics. `Run` and `RunSummary` gain optional schedule provenance (`scheduleId`, `generation`, `scheduledFor`, `catchUp`), including watch snapshots. Manual run shapes remain unchanged. Human output points blocked schedules to normal run inspection and wait/cancel commands. See `packages/runtime/src/schedule-protocol.ts` for concrete request/response schemas and the approved contract for timing and retention details.

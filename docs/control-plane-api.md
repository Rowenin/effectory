# Library, CLI and MCP APIs

Scope correction: the current requested design is [CLI commands and server RPCs](cli-server-api.md). This earlier, broader draft is retained as exploration. Its library/MCP APIs are not selected; RPC naming and CLI contracts in the focused catalogue take precedence.

Status: proposed public contracts, not implemented or typechecked. This extends the selected [graph authoring API](authoring-runtime.md) and covers all three interaction primitives from [pausing and input](pausing-and-input.md).

Customers define tasks and workflows in TypeScript. The control plane discovers those definitions, starts durable runs, inspects results, answers waits and queries data. The library, CLI and MCP adapters expose the same operations and validation. The daemon owns execution independently of whichever client submitted the work.

## Consumer experience

```sh
effectory daemon start
effectory workflow list
effectory workflow describe release-summary --json
effectory workflow plan release-summary --input '{"repository":"swamp-club/swamp"}'
effectory workflow run release-summary --input '{"repository":"swamp-club/swamp"}' --background
effectory run get <run-id> --json
effectory run waits <run-id> --json
effectory run approve <wait-id> --request-key release-review-42
effectory run watch <run-id>
effectory run outputs <run-id> --json
```

`release-summary` is an illustrative `Workflow.make` spec ID, registered in the application. It is not inferred from a filename, variable name or CLI context. `describe` exposes the schema before the caller supplies input. `plan` resolves the selected graph and extensions without executing task handlers. `run` returns the durable identity used by every subsequent interface.

Proposed library usage, with application schemas and a daemon connection supplied by the caller:

```ts
import { ControlPlane } from "@effectory/client";
import { Effect } from "effect";

const submitRelease = Effect.gen(function* () {
  const client = yield* ControlPlane;
  const definition = yield* client.workflows.describe({
    id: "release-summary",
  });

  return yield* client.workflows.run({
    id: definition.id,
    revision: definition.revision,
    input: { repository: "swamp-club/swamp" },
    requestKey: "release-summary-42",
  });
});

// Proposed connection Layer; endpoint discovery/authentication happen here.
const program = submitRelease.pipe(
  Effect.provide(ControlPlane.layer({ repository: "/work/releases" }))
);
```

`ControlPlane.layer` binds to the repository's daemon. It does not start the daemon or import customer application code. An in-process host can provide the same service through a host Layer. All client methods are Effects except `runs.watch`, which returns a Stream. The exact service declaration and package exports require a prototype; this example is a proposed consumer contract.

Calling `workflows.run` from an Effect program submits a new durable run. It is different from declaring a node with `graph.task`. Typed handles accepting a known Task/Workflow spec can be added later; dynamic discovery returns schema-described JSON and does not pretend to infer a result type from a string ID.

## Baseline operation catalogue

In these tables, library methods are on `client`. CLI commands begin with `effectory`. MCP tools have the prefix `effectory_`. Braces mean separate named operations, not one tool with an arbitrary action string. ID arguments, filters and mutation keys are specified below.

### Discover, validate and submit

| Library | CLI | MCP tool suffix | Closest Swamp operation |
| --- | --- | --- | --- |
| `tasks.list` | `task list` | `task_list` | `behavior type search`; partial mapping |
| `tasks.describe` | `task describe <id>` | `task_describe` | `behavior type describe`, method schema |
| `tasks.validate` | `task validate <id> --input …` | `task_validate` | `behavior validate/evaluate`; partial mapping |
| `tasks.run` | `task run <id> --input …` | `task_run` | `behavior run <definition> <method>` |
| `workflows.list` | `workflow list` | `workflow_list` | `workflow search` |
| `workflows.describe` | `workflow describe <id>` | `workflow_describe` | `workflow get/schema` |
| `workflows.validate` | `workflow validate <id> --input …` | `workflow_validate` | `workflow validate` |
| `workflows.plan` | `workflow plan <id> --input …` | `workflow_plan` | `workflow evaluate`; related, not identical |
| `workflows.run` | `workflow run <id> --input …` | `workflow_run` | `workflow run` |

`list` accepts optional search text, namespace, limit and cursor. `describe` returns ID, spec version, application revision, description, input/success/error JSON Schemas, provider provenance and allowed operations. Task metadata includes replay policy. A task represents one callable method; task discovery does not yet replace Swamp's configured behavior-definition discovery.

`validate` checks supplied encoded input against the pinned codec and checks the selected definition. It returns `{ valid, issues }`, including paths and codes, without executing task handlers. `plan` additionally returns nodes, dependencies, wait kinds, policies and applied extension patches. It cannot predict task results, branch choices or fan-out counts that depend on runtime data. Such nodes are explicitly unresolved. Construction must satisfy the documented deterministic build restrictions for this to be safe.

`run` requires `{ id, input, requestKey }`; `revision` is optional. If omitted, the server resolves the active application revision once at acceptance and stores it. A repeated request key returns that original run even if the active revision has changed. An explicit different revision or different encoded input conflicts. Preflight `validate` is optional; submission always validates authoritatively.

### Observe and control runs

| Library | CLI | MCP tool suffix | Closest Swamp operation |
| --- | --- | --- | --- |
| `runs.list` | `run list` | `run_list` | `run history`, behavior/workflow history search |
| `runs.get` | `run get <run-id>` | `run_get` | behavior/workflow history get |
| `runs.events` | `run events <run-id>` | `run_events` | history and persisted run-state inspection |
| `runs.watch` | `run watch <run-id>` | — | foreground run progress |
| `runs.logs` | `run logs <run-id>` | `run_logs` | behavior output/workflow history logs |
| `runs.outputs` | `run outputs <run-id>` | `run_outputs` | behavior output data/workflow history outputs |
| `runs.cancel` | `run cancel <run-id>` | `run_cancel` | `behavior cancel`, `workflow cancel` |

`get` returns target/revision, timestamps, status, progress, open wait count and result/error or artifact references. Proposed terminal outcomes are `Succeeded`, `Failed`, `Rejected`, `TimedOut` and `Cancelled`. A domain failure and an operator rejection remain distinct. `Waiting` is nonterminal and means no branch can currently progress; individual open waits can also exist in a `Running` run.

`list` filters by target, kind, status and creation time. `events` and `logs` return bounded pages with cursors; events have an increasing sequence per run. `watch` streams the same events from an optional `afterSequence`. Cursor expiry is an explicit error with a current snapshot, never an unnoticed gap. `outputs` lists task/node results and lake references, and distinguishes partial from final output.

`cancel({ runId, requestKey })` records cancellation intent. Its receipt can report `Cancelling`; finalizers and running work may still need to settle. It cannot undo external effects already performed. Repeating cancellation against an already terminal run reports its existing state without changing its outcome.

There is no ordinary `resume` step after answering a wait: continuation is queued automatically. Swamp's `recover/resume` operator functionality still needs a separate reconciliation API for `NeedsAttention`. Do not expose a generic resume that blindly repeats an uncertain external side effect. Rerunning a terminal workflow means a new submission and new request key; a dedicated retry/fork API and its reuse semantics are deferred.

### All three interaction primitives

| Graph declaration | Library | CLI | MCP tool suffix | Swamp equivalent |
| --- | --- | --- | --- | --- |
| Any open wait | `waits.list/get` | `run waits [run-id]`, `run wait <wait-id>` | `wait_list`, `wait_get` | `workflow approvals/waits` |
| `graph.approval` | `waits.approve` | `run approve <wait-id>` | `wait_approve` | `workflow approve` |
| `graph.approval` | `waits.reject` | `run reject <wait-id> --reason …` | `wait_reject` | `workflow reject` |
| `graph.requestInput` | `waits.respond` | `run respond <wait-id> --input …` | `wait_respond` | `wait_for_signal` used for human input |
| `graph.waitForSignal` | `waits.signal` | `run signal <wait-id> --payload …` | `wait_signal` | `workflow signal` |

Library/MCP arguments:

```ts
client.waits.list({ runId, status: "Open", limit: 50 });
client.waits.get({ waitId });
client.waits.approve({ waitId, requestKey });
client.waits.reject({ waitId, reason: "Revise the release notes", requestKey });
client.waits.respond({ waitId, input: { environment: "staging" }, requestKey });
client.waits.signal({
  waitId,
  payload: { deploymentId: "deploy-42" },
  requestKey,
});
```

These are independent examples: input/payload must match each wait's own schema. Each mutation returns a receipt with `waitId`, `runId`, outcome, recorded actor, settlement time and continuation state. It confirms durable settlement, not downstream completion. The authenticated principal supplies identity; no argument allows a caller to choose the recorded actor. Host policy determines who can approve, including whether an agent principal is eligible. MCP tool invocation alone does not prove that a human reviewed a gate.

`waits.list` can filter by run, kind and status; the default is open waits. `get` returns the current state, deadline, allowed actions and authorized prompt/context or schema. A wait ID identifies an opened interaction, not the authoring node ID. Wrong-kind operations, expired/closed waits, validation failures and conflicting deliveries have distinct tagged errors. Invalid answers leave the wait open.

The shared [settlement contract](pausing-and-input.md#shared-operator-and-rpc-contract) governs idempotency and answer/timeout/cancellation races. Signals still require an already-open exact wait ID. A register-before-trigger authoring handle and early event delivery remain open design work; the CLI/MCP adapter does not solve that race by itself.

### Lake, extensions and diagnostics

| Library | CLI | MCP tool suffix | Closest Swamp operation |
| --- | --- | --- | --- |
| `lake.query` | `lake query --file query.json` | `lake_query` | `data query/list/search` |
| `lake.get` | `lake get <artifact-id> --version <n>` | `lake_get` | `data get` |
| `lake.versions` | `lake versions <artifact-id>` | `lake_versions` | `data versions` |
| `extensions.list/describe` | `extension list/describe` | `extension_list`, `extension_describe` | `extension list/info` |
| `extensions.add` | `extension add github:owner/repo@tag` | `extension_add` | `extension pull/install` |
| `extensions.update/remove` | `extension update/remove <id>` | `extension_update`, `extension_remove` | `extension update/rm` |
| `extensions.outdated` | `extension outdated` | `extension_outdated` | `extension outdated` |
| `operations.get/list` | `operation get/list` | `operation_get`, `operation_list` | Extension command progress; new durable operation identity |
| `system.status` | `daemon status` | `system_status` | `serve` status and repository status |
| `system.doctor` | `doctor` | `system_doctor` | `doctor`, `run doctor` |

`lake.query({ query, cursor? })` accepts the versioned [query AST](data-lake.md#query-boundary). It returns schema-tagged rows, a snapshot and cursor. `get({ artifactId, version })` returns exact-version metadata and bounded JSON or a content reference; large binary data stays out of tool results. CLI `--output <path>` may download content through an authenticated endpoint. MCP accepts no destination filesystem path. `versions` is a bounded metadata listing. Read visibility applies before filtering, counts and pagination.

Extension changes accept a request key and `expectedRevision`, and return a durable `operationId`. Add accepts a GitHub source; update accepts an installed ID and an explicit target ref; remove accepts an installed ID. `outdated` checks available versions without activating them. Installation follows the existing [staging, verification and activation contract](extensions.md#installation-and-activation). The final operation result identifies the new registry revision or structured failure. Existing runs retain their pinned bundles. An operation is administrative work and is not an author-defined Task or a workflow run.

`doctor` is read-only diagnosis with structured findings. Repair, GC and pruning need separate mutation contracts; a diagnostic request does not perform them.

## Boundary schemas and RPC

Each operation has an Effect Schema for its request, success and tagged errors. The library consumes these contracts; Effect RPC and MCP are adapters to the same application services. Operation schema definitions must precede hand-written CLI formatting. Proposed RPC family names are `Task.*`, `Workflow.*`, `Run.*`, `Wait.*`, `Lake.*`, `Extension.*`, `Operation.*` and `System.*`. Wire tags can be `TaskRun`, `WaitRespond`, etc.; the [focused catalogue](cli-server-api.md) now defines the exact proposed tags and payloads.

| Schema | Required contract |
| --- | --- |
| Target request | Namespaced ID, optional exact application revision, encoded JSON input where applicable |
| RunAccepted | Run ID, target kind/ID, pinned revision, accepted timestamp and current status |
| RunSnapshot | Status discriminant; success/error/control-outcome payloads appropriate to that status |
| WaitDescription | Wait/run/node identity, kind, deadline, status and authorized action/schema metadata |
| WaitReceipt | Settled outcome, authenticated actor, timestamp and durable continuation state |
| Page | Bounded items and optional opaque next cursor; snapshot identity where required |
| OperationAccepted | Operation ID, kind, accepted timestamp and current status |
| ControlPlaneError | Tagged error, safe message, structured details and request correlation ID |

Refine IDs, integer limits, durations, cursors and payload sizes. Unknown JSON is allowed only at the dynamic input/result positions; the pinned task or wait codec then validates those positions. Decoders are authoritative on the host. JSON Schema export supports discovery and editors but cannot replace Effect validation. Unsupported boundary codecs fail definition registration with an actionable error.

Common errors include `NotFound`, `InvalidInput`, `Unauthorized`, `Conflict`, `RevisionUnavailable`, `Unavailable` and `CursorExpired`; waits add `WrongWaitKind` and `WaitClosed`. Preserve issue paths for invalid JSON values. A status read of a failed run is a successful operation containing a failed outcome.

Every mutation carries a request key. Submission keys are scoped to repository and principal. The fingerprint includes operation, target, supplied revision selector and canonical encoded input; the receipt also stores the resolved revision. An omitted selector stays omitted for comparison on retry. This prevents a changed active revision from turning a lost-response retry into a new run. Wait keys follow the more specific repository/wait settlement contract. Extension operation keys cover the source, expected revision and requested action; replay lookup precedes rechecking an already-consumed expected revision. Authorization is always checked before returning an existing receipt.

## CLI behavior

All data commands support `--json`; structured results go to stdout and diagnostics to stderr. Bounded reads print one JSON document. `run watch --json` emits JSON Lines because it is a stream. `--input` and `--input-file` are mutually exclusive; `--input-file -` reads stdin. Signals similarly support `--payload-file`.

The CLI creates a request key before a mutation and preserves it across its own transport retries. `--request-key` lets scripts reuse a key across invocations; keys are included in receipts and uncertain-delivery diagnostics. A newly invoked command without that flag is a new intent. MCP and library callers supply keys.

By default, `task run`/`workflow run` submit and observe until terminal or fully waiting. On waiting, show the run ID, open waits and exact follow-up commands, then exit. `--background` exits after acceptance. `run watch` remains attached through waits until terminal or Ctrl-C. Disconnecting any observer does not cancel the run; `run cancel` is explicit.

Exit codes: 0 for accepted background work, successful reads and successful completion; 1 for Failed/Rejected/TimedOut/Cancelled foreground completion; 2 for invalid arguments or schema input; 3 for unavailable daemon/transport; 4 for a foreground run stopping at Waiting; 5 for authorization/conflict/closed-state operation errors; 130 for interrupted observation. An unresolved delivery must be reported as uncertain with its key, not as proof that nothing was accepted.

`init`, `dev`, `daemon start/stop`, `mcp serve`, help and completions are local client/process operations. They are not arbitrary remotely callable MCP tools.

## MCP behavior

Launch `effectory mcp serve --repository /work/releases` as a client-managed stdio adapter. It connects to the daemon using the same repository identity handshake. The MCP process lifetime never owns run lifetime. Standard output contains only protocol messages; diagnostics use stderr. This follows the versioned [MCP stdio transport contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). Remote Streamable HTTP support is a later adapter with its own authentication.

Expose a fixed catalogue of tools such as `effectory_workflow_describe`, `effectory_workflow_run`, `effectory_run_get` and `effectory_wait_respond`, with object input schemas and structured output schemas. Use MCP `isError` for operation failures, not for a successfully inspected failed run. Read/destructive/idempotency annotations describe behavior; host authorization still applies. The [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) defines these protocol facilities. The 2025-11-25 pages are a compatibility reference, not a claim to be the latest protocol revision.

Installations add entries to task/workflow discovery rather than dynamically creating a tool for every contributed task. The agent describes a definition, submits using its revision and encoded input, and receives `RunAccepted` promptly. It uses bounded `run_get/events/logs` calls to inspect progress. There is no unbounded `run_watch` tool and no requirement for MCP protocol-level Tasks support; Effectory Task definitions and MCP protocol tasks are different concepts.

The adapter is bound to one repository and principal at launch. Tool arguments cannot select arbitrary local repositories. Tool visibility is filtered by host policy; the catalogue lists supported operations, not permission to use all of them. Task and extension descriptions are untrusted display content.

Optional client elicitation can render an input request during a supported interaction. It is an adapter convenience; durable waits remain usable without that client capability. Form elicitation cannot collect credentials, per the [MCP elicitation specification](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation). Our proposed mapping submits accepted data through `Wait.respond`; closing or declining a form leaves the wait open. An approval rejection requires an explicit authorized `Wait.reject`, and cancelling a form never cancels a run.

## Swamp coverage and deliberate gaps

The comparison uses the [pinned checkout](../vendor/README.md). Swamp explicitly states that it runs no MCP server in its [architecture](../vendor/swamp/design/architecture.md); our MCP adapter is an additional interface, not compatibility with an existing Swamp MCP API.

Source command inventories: [behavior](../vendor/swamp/src/cli/commands/behavior.ts), [workflow](../vendor/swamp/src/cli/commands/workflow.ts), [data](../vendor/swamp/src/cli/commands/data.ts), [extension](../vendor/swamp/src/cli/commands/extension.ts), [vault](../vendor/swamp/src/cli/commands/vault.ts), [run](../vendor/swamp/src/cli/commands/run.ts).

| Swamp capability | Effectory disposition |
| --- | --- |
| Behavior methods and workflow execution | Covered by task/workflow discovery, validation, submission and run inspection |
| Approval and signal interactions | Covered; human input gets a distinct authoring and operator API |
| Data queries, versions and output inspection | Covered by lake and run methods; query language differs |
| Extension consumption | GitHub add/update/remove plus operation receipts; hosted publishing/registry management deferred |
| YAML workflow create/edit/delete | Edit TypeScript exports; application reload publishes a new revision. No remote source-editing tool proposed |
| Named configured behavior definitions and leases | Still a modeling gap; TaskGroup and service Layers do not establish feature parity |
| Resume/recover and reconciliation | Automatic wait continuation covered; operator decisions for uncertain side effects remain to design |
| Vault providers and secret management | SecretStore execution boundary exists; provider configuration and operator methods require a separate contract. No plaintext secret MCP tools proposed |
| Cron, triggers, webhook ingestion | Trigger adapter slot exists; schedule CRUD, delivery deduplication and callback registration still need API design |
| Data delete/rename, GC/prune, repair, backup | Defer until reference protection, retention and administrative operation semantics are specified |
| Reports, audit, access administration | Run events/provenance are partial coverage; report definitions, dedicated audit queries and role administration remain open |
| Multi-worker serving, workspace/cloud and agent features | Beyond the initial single-repository daemon scope |

This is a baseline control-plane proposal, not complete Swamp command parity. Before implementation, prototype schema export and library/RPC agreement, then verify cross-client submission/answering, restart recovery, bounded pagination, permission filtering and retry-after-lost-response behavior. No behavior described here has been executed in this documentation pass.

# Daemon, RPC and CLI

See [Customer applications and the edge runner](edge-runtime.md) for entry-point discovery, `Application.make`, development reloads and revision loading. The [CLI and server RPC catalogue](cli-server-api.md) defines exact proposed commands, RPC tags, request/response contracts and Swamp equivalents. It is the current API proposal; the earlier library/MCP draft remains exploratory.

## Process model

Start with one Bun daemon per repository. It owns an exclusive repository lock, SQLite connections, an Effect scope and the worker supervisor. The CLI discovers the repository, reads private connection metadata, authenticates, and calls RPC. Use a loopback HTTP endpoint for the initial cross-platform transport. An unpredictable token and repository ID handshake are required even on loopback; refuse non-loopback binding until remote authentication is implemented.

`daemon start` waits for readiness; `status` reports runtime/protocol versions, registry revision and drain state. `stop` requests a bounded drain. OS service installation is a later adapter; the library never assumes launchd/systemd. Stale metadata is checked against the live endpoint and lock, not just a PID. Never accept mutations before migrations and recovery reconciliation finish.

## RPC contract

Use `effect/rpc` on both sides. The following is the upstream-supported shape; `WorkflowRunRequest`, `RunAccepted`, `SubmitError`, `RunEvent` and `WatchError` stand for Effectory schema declarations to implement:

```ts
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

const Runs = RpcGroup.make(
  Rpc.make("WorkflowRun", {
    payload: WorkflowRunRequest,
    success: RunAccepted,
    error: SubmitError,
  }),
  Rpc.make("RunWatch", {
    payload: { runId: Schema.String, afterSequence: Schema.Number },
    success: RunEvent,
    error: WatchError,
    stream: true,
  })
);
// Runs.toLayer({ WorkflowRun: ..., RunWatch: ... }) binds application handlers.
```

Production schemas refine run IDs and non-negative integer cursors. See the pinned [Rpc.make](../vendor/effect/packages/effect/src/rpc/Rpc.ts) and [RPC tests](../vendor/effect/packages/effect/test/rpc/Rpc.test.ts).

| Procedure family | Inputs | Results / key errors |
| --- | --- | --- |
| System | repository ID, protocol version | compatibility, readiness, capabilities |
| Task / Workflow | ID/revision/filter/input | discovery, schemas, validation, workflow plan and submission |
| TaskRun / WorkflowRun | task/workflow ID, revision, encoded input, request key | run ID + persisted status; invalid input, conflict, unavailable |
| Run.get/list | run ID / bounded filter and cursor | statuses, result references; not found |
| Run.watch | run ID, last sequence | streamed persisted events; cursor expired |
| Run.cancel | run ID, request key | current cancellation status; already terminal |
| Wait.list/get | run/kind/status filters or wait ID | authorized wait metadata, schema and allowed actions |
| Wait.approve/reject/respond/signal | wait ID, operation-specific value, request key | persisted settlement receipt and continuation state; conflict, closed, wrong kind, unauthorized |
| Lake.query/get | query AST / artifact ID and version | bounded page / content reference; invalid query, unavailable content |
| Extension.add/update/remove | source/target ref or installed ID, expected registry revision, request key | operation ID; incompatible, conflict, verification failed |
| Operation.get/list | operation ID / bounded filter and cursor | extension operation progress and final result |

Long extension operations use persisted operation records rather than keeping a single RPC open. Every mutation has an idempotency key and authorization check. The RPC major version is separate from task/schema versions; incompatible handshakes fail before submission. Large artifacts use bounded streaming or a separate authenticated content endpoint, not giant JSON responses.

## Submission and watching

A successful submission means the run row and dispatch intent are committed. A disconnected response can be retried with the same request key; it returns the same run. Reusing that key with different input or an explicit different revision returns Conflict. The scope of the key is repository plus principal. The request fingerprint includes operation, target, supplied revision selector and canonical encoded input. The resolved revision is stored separately with the receipt. When the caller omitted a revision, retry lookup preserves that omission and returns the first accepted run even if the active revision has since changed.

Watching is an observer operation. Disconnect and Ctrl-C stop observation without cancelling the submitted work. Cancellation is explicit. Events have increasing per-run sequence numbers, timestamp, schema version and tagged payload. Resume from the last observed sequence; a bounded queue prevents slow readers retaining unlimited memory. Persist events before notifying watchers. If retention removed the cursor, return CursorExpired and a current status/snapshot, never a silent gap.

## Proposed CLI

```sh
effectory daemon start
effectory task list --json
effectory task run example/greet --input '{"name":"Ada"}' --background
effectory workflow run example/welcome --input '{"name":"Ada"}' --background
effectory run watch <run-id>
effectory run get <run-id> --json
effectory run cancel <run-id>
effectory extension add github:owner/repository@v1.2.0
effectory lake query --file query.json --json
```

Default run mode submits and observes until terminal or fully Waiting, then exits with a result or wait instructions. `--background` prints the accepted run ID and exits. Explicit `run watch` stays attached through waits. JSON mode writes only structured results to stdout; streaming watch uses JSON Lines and diagnostics go to stderr. Exit codes distinguish acceptance/success (0), unsuccessful terminal outcomes (1), bad input (2), transport/unavailable (3), Waiting (4), authorization or state conflicts (5), and interrupted observation (130). A background command's zero exit code means acceptance, not task success. See the [CLI contract](cli-server-api.md#cli-conventions-and-one-complete-interaction) for request keys and exact behavior.

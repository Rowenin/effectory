# Pausing, approvals and input requests

Status: Swamp source analysis and an Effectory proposal. The graph concept is selected; the interaction method names and policies below are not yet accepted. Evidence is from the [pinned Swamp checkout](../vendor/README.md), not a live test.

## What Swamp actually provides

### Manual approval: a yes/no gate

A workflow step with `task.type: manual_approval` has a prompt and an optional timeout. Reaching it marks the step `waiting_approval` and the run `suspended`. Already-running siblings at that execution level drain before the consistent checkpoint is saved. The local run command exits; the pause is persisted state, not a terminal prompt keeping the original process alive.

```yaml
- name: review
  task:
    type: manual_approval
    prompt: Publish this release?
    timeout: 3600
```

The normal local sequence is `workflow run`, then `workflow approve`, then `workflow resume`. Approving records who decided and marks the gate succeeded; it does not itself execute the remaining steps. Rejecting records the reason and fails/settles the run. Local identity comes from the OS user; serve performs the remote authorization checks.

An expired approval is refused and remains suspended for cancellation in the inspected revision. It is not automatically equivalent to rejecting the approval. This is an important behavior to choose deliberately rather than copy accidentally.

Sources: [approval documentation](../vendor/swamp/design/primitives/workflows.md#manual-approval-manual_approval), [approve](../vendor/swamp/src/libswamp/workflows/approve.ts), [reject](../vendor/swamp/src/libswamp/workflows/reject.ts), [timeout logic](../vendor/swamp/src/domain/workflows/approval_timeout.ts).

### Wait for signal: typed external data

`task.type: wait_for_signal` pauses for a JSON object. It requires a payload schema and a finite timeout. Later steps read the accepted payload as this step's output; they can branch on it. This can represent a user answering a question, a callback from an external service, or an automated decision.

```yaml
- name: destination
  task:
    type: wait_for_signal
    timeout: 86400
    schema:
      type: object
      additionalProperties: false
      required: [environment]
      properties:
        environment:
          type: string
          enum: [staging, production]
```

```sh
swamp workflow waits
swamp workflow signal <wait-id> --payload '{"environment":"staging"}'
swamp workflow resume <workflow>
```

A wait captures its schema and absolute deadline when opened. Editing the workflow afterward does not change what that existing wait accepts. Payloads are limited to a JSON object of 16 KiB and nesting depth 16, and dangerous prototype-related keys are rejected. Swamp only allows schema keywords its validator enforces; this is not general JSON Schema support. Signal payloads are persisted in plaintext and are not a channel for secrets.

The output includes the payload and a receipt containing signal/wait IDs, submission time and actor. Idempotency keys support retrying delivery after a lost reply. Optional named wait keys and bounded early delivery exist, but they add coordination beyond simply addressing a currently open wait by its ID.

Sources: [signal documentation](../vendor/swamp/design/primitives/workflows.md#wait-for-signal-wait_for_signal), [SignalWait](../vendor/swamp/src/domain/workflows/signal_wait.ts), [signal use case](../vendor/swamp/src/libswamp/workflows/signal.ts).

### Answering and continuation are separate

Signal registration and settlement have separate persistent records. A signal, timeout and cancellation compete to create the same write-once outcome; only one wins. The signal receiver records the outcome without rewriting the workflow run. Resume applies it under the run's claim and continues pending work.

Serve can auto-resume after decisions, but that is a policy. An explicit workflow `autoResume` wins. Otherwise the server default applies only to workflows without declared inputs; the default server setting is off. A continuation sweep retries eligible settled runs, recovers missed wakeups and handles eligible expired signal waits. It does not treat an expired manual approval the same as a signal timeout.

Swamp also permits resume-time inputs. In this revision, already-present input values are immutable: resume can add previously absent values or resupply the same ones, but changing existing values is refused. This is distinct from a signal supplying a particular waiting step's result.

Sources: [wait records](../vendor/swamp/src/domain/workflows/signal_wait_records.ts), [atomic persistence](../vendor/swamp/src/infrastructure/persistence/control_plane_signal_wait_store.ts), [continuation checks](../vendor/swamp/src/domain/workflows/run_continuation.ts), [auto-resume policy](../vendor/swamp/src/domain/workflows/workflow.ts), [resume inputs](../vendor/swamp/design/primitives/workflows.md).

## Proposed Effectory abstraction

Use one durable wait mechanism underneath distinct author-facing intentions:

- **Approval:** ask permission to proceed, with a recorded decision and actor.
- **Input request:** ask a person for schema-validated data, with prompt/display metadata that CLI or UI clients can render.
- **Signal wait:** await schema-validated data from a person or external system, without requiring a human-facing form.
- **Durable delay:** await a persisted deadline; it needs no answer endpoint.

These should be graph primitives, not ordinary task handlers that read stdin or hold a Deferred in process memory. A CLI, UI and webhook are adapters that list and settle the same waits. A workflow must work unattended and without an attached CLI. Effect's [DurableDeferred](../vendor/effect/packages/effect/src/workflow/DurableDeferred.ts) and [DurableClock](../vendor/effect/packages/effect/src/workflow/DurableClock.ts) are implementation candidates; their exact integration must be proven with restart tests. Use the persistent timer path, including for short workflow delays.

## Three public API proposals

All three operations return construction Effects. Yielding one declares a graph node; the interaction opens only when that node becomes eligible during a run. The snippets below belong inside the construction Effect passed as the second argument to `Workflow.make`. `graph` comes from `yield* Workflow.Builder`. These are proposals for review, not accepted or implemented exports.

| Operation | Intent | Successful reference value | Unhandled terminal outcome |
| --- | --- | --- | --- |
| `graph.approval(id, options)` | Obtain permission before proceeding | `ApprovalPermit` | Rejected or TimedOut |
| `graph.requestInput(id, options)` | Ask a person for structured data | Decoded `schema.Type` | TimedOut |
| `graph.waitForSignal(id, options)` | Receive one externally delivered event | Decoded `schema.Type` | TimedOut |

`Ref<T>` denotes a typed graph reference, not an Effect that can be yielded for a runtime value during construction. Each constructor conceptually returns `Effect<Ref<T>, GraphDefinitionError, Workflow.Builder>`; schemas and actual service/type signatures still need a prototype. Runtime outcomes are separate from the construction Effect's error channel.

Common options:

- `timeout`: required positive finite duration, validated against host limits. Its absolute deadline is computed once when the wait opens, not when the graph is constructed or the run is submitted. Restart never resets that deadline.
- `after`: optional node references establishing execution ordering without input data flow. Dependent nodes require successful completion, not merely settlement.
- `description`: optional text for inspection and operator discovery.

All IDs are scoped to the workflow invocation; nested and fan-out paths are part of identity. A runtime-generated `waitId` identifies one opened interaction of one run. It is distinct from the author-supplied node ID and is never reused for a new run or wait generation.

### Proposal A: approval as a gate

```ts
const approval =
  yield *
  graph.approval("publish-review", {
    prompt: "Approve publishing this release?",
    context: summary,
    timeout: "24 hours",
  });

return (
  yield *
  graph.task("publish", PublishSummary, summary, {
    after: [approval],
  })
);
```

Here `summary` is an upstream reference and PublishSummary accepts its value. `context` is optional schema-encoded, non-secret data shown to the reviewer; it also makes the gate wait for that upstream data. The resolved prompt and context are captured when the gate opens so the person approves the exact snapshot that execution will use. Dynamic prompt expressions may be added once reference transforms are defined; a static prompt plus typed context is sufficient initially.

Recommend making `approval` a gate, not a Boolean. It produces an opaque ApprovalPermit reference only after approval. Downstream `after` edges require that permit. The permit is an execution dependency, not an authentication token; it cannot grant another run's permission or be forged by a task result.

Rejection produces a standardized `Rejected` run outcome with wait/node ID and an optional reason. Expiry produces `TimedOut`. Neither outcome fabricates a successful permit nor leaves downstream work waiting forever. These are control outcomes outside the workflow's declared domain error schema, so an extension can insert a gate without inventing a new business error type.

An unhandled rejection/timeout ends the run, closes other open waits and interrupts remaining work under the existing cancellation/finalization contract. It does not undo completed external effects. An independent branch may have already run; author dependencies must place the gate before every action it is meant to protect.

Proposed commands:

```sh
effectory run approve <wait-id> --request-key review-42
effectory run reject <wait-id> --reason "Release notes need revision" \
  --request-key review-42
```

The two commands are alternatives for one decision, not a sequence. The server records the authenticated actor and decision time; client JSON cannot nominate an arbitrary approver identity. Changing an accepted decision requires a new run or an explicit future re-review operation, not overwriting history.

A workflow that needs to continue differently after yes/no needs an explicit branching decision primitive. Do not overload this gate with an optional Boolean mode in the first proposal. Its naming and branch result type can be designed alongside the graph's branch/match API.

### Proposal B: schema-backed user input

```ts
const destination =
  yield *
  graph.requestInput("destination", {
    prompt: "Where should this release be deployed?",
    schema: Schema.Struct({
      environment: Schema.Literals(["staging", "production"]),
      reason: Schema.String,
    }),
    timeout: "24 hours",
  });

return yield * graph.task("deploy", DeployRelease, destination);
```

DeployRelease is a hypothetical task accepting the answer schema. The returned reference represents exactly the decoded answer, not a receipt wrapper. Audit metadata remains available in the run/wait records. Passing this reference as input creates the dependency on valid user input.

A request requires `prompt`, `schema` and `timeout`; `context` is optional with the same snapshot behavior as approval. CLI/UI adapters may render choices and fields from schema annotations. Authoring never assumes a TTY or opens a modal itself. Free-form strings and other JSON-compatible schema shapes are permitted; a struct is useful for multi-field forms but is not required.

Proposed command:

```sh
effectory run respond <wait-id> \
  --input '{"environment":"staging","reason":"Validate before production"}' \
  --request-key destination-42
```

Malformed JSON, schema failures or authorization failures leave the request open. Return field-level validation errors to the caller; do not fail the workflow for a mistyped answer. Empty strings, null and omitted values are accepted only when the declared schema permits them. Answers never alter the workflow's original input. They become the named request node's output.

On expiry, the proposed default is a standard TimedOut run outcome. No default answer is silently invented. A user abandoning a form is not an answer or rejection; the wait remains open until responded to, cancelled with its run, or expired. Fallback branches should use a future explicit outcome-handling operator rather than weakening the success reference into `T | undefined`.

### Proposal C: schema-backed external signal

```ts
const completion =
  yield *
  graph.waitForSignal("deployment-completed", {
    schema: Schema.Struct({
      deploymentId: Schema.String,
      status: Schema.Literals(["succeeded", "failed"]),
      url: Schema.String,
    }),
    description: "Completion event from the deployment service",
    timeout: "2 hours",
  });

return yield * graph.task("record-deployment", RecordDeployment, completion);
```

RecordDeployment is a hypothetical task accepting this event schema. The signal operation has no required prompt and does not create a human form. It records one valid event and resolves its output reference. A payload with `status: "failed"` is still a successfully received signal; the workflow/task decides what that business status means. Transport timeout is a separate control outcome.

Proposed command for operators and integration tests:

```sh
effectory run signal <wait-id> \
  --payload '{"deploymentId":"deploy-42","status":"succeeded","url":"https://example.test"}' \
  --request-key deployment-event-42
```

An authenticated external adapter calls the same schema-defined RPC operation; there is no separate workflow execution path for webhooks. `waitId` identifies the exact receiver and is not a credential. Provider adapters verify incoming webhook signatures and map provider events to the correct authorized wait before submitting the payload.

V0 is one-shot, exact-wait delivery: no broadcast, event stream, implicit queue, name-only routing or early buffering. A wait ID is available in the persisted WaitOpened event and wait listing. A producer must discover the opened wait before it delivers, or an adapter must durably buffer events outside this API. An unknown wait returns WaitNotFound; an expired/settled one returns its closed state. Do not recommend starting a fast external job and only afterward opening its callback wait: that loses events. A graph-level register-before-trigger address handle must expose registration separately from waiting for completion to avoid a dependency cycle. The subsequent [registration/await proposal](durability-and-recovery.md#separate-external-signal-registration-from-waiting) now defines a candidate API and lifecycle; it has not been accepted or proven.

When a signal opens, persist correlation metadata needed by its authorized adapter. Supplying the right ID and actor remains essential: validating the event's shape alone does not prove that the event belongs to the intended external job. Automatic keyed correlation and early delivery need their own explicit contract.

## Shared operator and RPC contract

The [CLI and server RPC catalogue](cli-server-api.md#approvals-input-and-signals) maps all three interactions to public methods and defines client response behavior.

```sh
effectory run waits <run-id> --json
```

Each returned open-wait description contains wait ID, run ID, qualified node ID, kind (`approval`, `input`, `signal`), opened time, deadline, allowed operations, and authorized prompt/context/schema metadata. Sensitive content must not leak to users who can see a run but cannot view its requests. Definitions use Effect Schema as the validation authority; JSON Schema export is a rendering/discovery aid.

Proposed RPC families, with exact wire naming still open:

- `Wait.list/get`: discover an interaction and its current state.
- `Wait.approve/reject`: settle an approval.
- `Wait.respond`: submit typed user input.
- `Wait.signal`: deliver an external event.

All mutations require an idempotency key scoped to repository and wait. Record the operation, principal, canonical payload fingerprint and receipt. Retrying the same authorized operation with that key and payload returns its original receipt, even after the run continues. Reusing it with different data/operation conflicts. A different key cannot overwrite a settled answer. Wrong-operation errors (such as `respond` on an approval) are explicit. Authorization is checked even when returning a prior receipt.

The response confirms that the decision/answer is durably committed and whether continuation is queued; it never promises the downstream workflow has completed. The daemon resumes eligible graph nodes automatically. No second resume command is needed in the ordinary flow. A disconnected answering client does not undo an accepted answer or stop continuation.

Recommend allowing service-free, JSON-compatible Effect codecs, including explicit transformations/defaults, provided the runtime retains the submitted encoded JSON and the canonical encoded result of the decoded answer. This makes any normalization auditable. The authoritative server decoder is pinned to the wait's application revision; UI validation is supplementary. Schema transforms must be deterministic and bounded. Renderers that cannot express a codec's checks must fall back to a JSON editor rather than promise incomplete validation.

## Persistence and execution semantics to specify

1. At execution time, atomically create the wait record and mark its node waiting. Record run/revision, qualified node path, wait ID/generation, schema identity, prompt metadata, deadline and authorization subject. Only then emit the request event. A restarted runner must rediscover it without asking a different question.
2. Validate an answer against the pinned Effect Schema before recording it. Preserve the encoded answer, actor, timestamp and delivery idempotency key. Invalid input leaves the wait open; it does not fail the workflow. Bounds on size and depth still apply even if the schema accepts broad JSON.
3. Atomically settle one outcome: answered, rejected (for an approval), timed out, or cancelled. Enforce the deadline during delivery, not just in a timer worker. A retried delivery with the same key and data returns its receipt; conflicting data must not overwrite an accepted answer.
4. Persist the continuation intent together with settlement, or use a durable reconciliation scan. Losing an in-memory wakeup must not lose progress. The scheduler claims the continuation once and evaluates newly ready nodes.
5. Only the dependency chain behind a wait stops. Other runnable branches may continue. A run becomes fully waiting when no work can progress; a pending user question is still discoverable while an independent branch runs. This is a proposed graph behavior, not a claim about Swamp's level-draining scheduler.
6. Waiting consumes no execution worker slot. Shutdown releases resources; restart reconstructs state from storage. Cancellation closes waits and prevents a late answer from reviving the run.

## Decisions still open

The three APIs above propose concrete defaults; they are not yet accepted.

- Confirm gate-style approval and standard Rejected/TimedOut outcomes. The proposed lifecycle and CLI contracts distinguish these from domain Failed and Cancelled; the implementation must enforce that distinction in its run state schema.
- Define a separate decision/result-handling API when rejection or timeout should select a fallback branch instead of terminating a run.
- Define mixed literal/reference inputs, `context` typing and the `after` dependency option once for all graph primitives. Do not make waits a second expression API.
- Define schema-to-form annotations and request-specific response permissions.
- Prototype the register-before-trigger signal handle before promising an ergonomic callback workflow; keep early delivery and keyed queues out of v0 until specified.
- Define configurable payload/depth/retention limits and receipt retention. Once an old receipt is collected, respond with an explicit expired-history error; never silently reuse its idempotency key for a new decision.
- Operator pause/resume of an already-running graph remains a separate feature. It needs a policy for in-flight side effects and is not process freezing.

## Acceptance evidence

Tests must cover restart with an open request; answering after client disconnect; invalid and duplicate answers; simultaneous answer/timeout/cancel; missed wakeups; independent branch progress; fan-out wait identity; pinned schema after a code update; gate ordering with independent branches; rejected/expired run settlement; wrong-operation errors; codec normalization receipts; signal-before-registration refusal; authorization; and prevention of resuming a cancelled run. No such behavior has been implemented or tested in this documentation pass.

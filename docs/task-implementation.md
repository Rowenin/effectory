# Task implementation contract

Status: planning pass 2 of 5. These are proposals extending the selected [authoring model](authoring-runtime.md), not accepted or implemented exports. Examples have not been typechecked. Preserve `Task.make(spec, handler)` and the graph/execution separation described in [graph composition](graph-composition.md).

## Recommendation

Use a handler with decoded input and an optional-to-use, spec-typed context:

```ts
Task.make(spec, (input, context) =>
  Effect.gen(function* () {
    // Ordinary Effect services perform application work.
    // Context identifies this invocation and publishes declared outputs.
  })
);
```

Simple handlers may still write `(input) => Effect.succeed(...)`. The callback's second parameter adds no extra constructor argument and requires no self-reference such as `const Fetch = Task.make(... yield* Fetch.context ...)`. Infer its output names and publication value types from `spec.outputs`. The context is supplied by the runner per attempt; authors never construct it for production execution.

Application clients, configuration and secrets remain Effect services supplied by Layers. The context is a narrow execution capability, not a service container or an escape hatch to mutate run state. Its methods return Effects where they do I/O.

| Context member | Proposed contract |
| --- | --- |
| `runId`, `invocationPath` | Stable identity and qualified graph-node path |
| `taskId`, `taskVersion`, `revision` | Pinned definition/provider identity |
| `attemptId`, `attempt` | Unique execution attempt ID and monotonic attempt number |
| `key(name)` | Stable opaque external-operation key for this invocation and name |
| `publish(output, value, options)` | Validate and commit a declared artifact; return its exact reference |
| `progress(update)` | Best-effort bounded progress, never a durable control decision |

All properties are readonly. A context is valid only within its active attempt; do not retain it in an application singleton or use it from detached fibers.

## A realistic task

This example submits a deployment to an application-defined external client and publishes its immutable receipt. `DeploymentClient.create` accepts the shown input and an idempotency key, and returns `DeploymentReceipt.schema.Type` with the domain error represented by `DeploymentError`. These imported application services/codecs are hypothetical; no provider implementation is claimed here.

```ts
import { Application, Artifact, Task } from "@effectory/core";
import { Effect, Schema } from "effect";

import {
  DeploymentClient,
  DeploymentClientLive,
  DeploymentError,
} from "./deployment-client";

const DeploymentReceipt = Artifact.make({
  id: "deployments/receipt",
  version: 1,
  schema: Schema.Struct({
    deploymentId: Schema.String,
    environment: Schema.String,
    revision: Schema.String,
    url: Schema.String,
  }),
});

export const StartDeployment = Task.make(
  {
    id: "deployments/start",
    version: 1,
    input: Schema.Struct({
      environment: Schema.String,
      revision: Schema.String,
    }),
    success: DeploymentReceipt.refSchema,
    error: DeploymentError,
    outputs: { receipt: DeploymentReceipt },
    replay: "idempotent",
  },
  (input, context) =>
    Effect.gen(function* () {
      const deployments = yield* DeploymentClient;
      yield* context.progress({ message: "Submitting deployment" });

      const receipt = yield* deployments.create(input, {
        idempotencyKey: context.key("create"),
      });

      const artifact = yield* context.publish("receipt", receipt, {
        key: "created",
        tags: { environment: input.environment },
      });
      yield* Effect.logInfo("Deployment receipt recorded");
      return artifact;
    })
);

export default Application.make({ tasks: [StartDeployment] }).provide(
  DeploymentClientLive
);
```

`Artifact.make({ ... })` is a proposed normalization to spec-first construction; older exploration used `Artifact.make(id, options)`. The important task contract is the declared `outputs` map and exact-reference result, not that constructor spelling. Query the published schema through the existing lake API; task success values and logs are not automatically lake artifacts.

This task starts work and returns a receipt; it does not wait for deployment completion inside the handler. A graph-level signal receives completion. That workflow must register its receiver before triggering the job, using the separate callback-registration design; merely placing a wait after this task is racy.

The example's replay declaration is valid only if the client/provider guarantees that the same key and payload recover the same immutable creation receipt across the supported recovery horizon. A provider that forgets keys too soon, or returns changing status data on replay, does not satisfy that contract. Use manual recovery or split/reconcile the operation instead of claiming idempotency.

## Inference and boundary validation

Conceptually the handler has the following shape; this is a type-design target, not a proven generic signature:

```ts
(input: Input.Type, context: TaskContext<Outputs>) =>
  Effect.Effect<Success.Type, DomainError.Type | TaskRuntimeError, R>;
```

The constructor must infer input, success, error and outputs from the spec without widening it from an incompatible handler. Context publication must reject unknown output names and incorrect values. Literal identity/version and external service requirements `R` must survive in the returned task definition. Do not erase `R` with a blanket cast or accept every Context requirement as host-provided.

The runner supplies only documented host services and the attempt Scope. All other requirements remain for task/application Layers to satisfy. Constructing a spec is pure; acquiring application clients happens when the application Layer is built. A missing service must remain a useful static error where possible and an actionable startup failure for dynamically loaded definitions.

Decode input with the pinned input codec before invoking the handler. Validate and encode success/domain error values before recording them. V0 boundary codecs must be service-free and JSON-compatible; decoded types may differ from encoded types. Artifact references carry schema identity and exact data version, not a live object, open handle or promise. Runtime read validation checks existence and digest in addition to the reference's schema shape.

## Identity, retries and publication

The logical invocation is stable across all its attempts. It includes repository, run and qualified node/fan-out/child path. `context.key("create")` derives a bounded external key from that identity plus the operation name. It is unchanged across retry/recovery and changes for a new run. The provider contract determines how long that key remains useful; it is not an exactly-once guarantee from Effectory.

Use distinct stable names for multiple external operations. Do not derive keys from attempt number, current time, random values or concurrent completion order. Stable fan-out item keys belong in the qualified invocation identity. Attempt IDs are for diagnostics and fencing, not external deduplication.

`publish("receipt", value, { key: "created" })` requires a stable caller key. The publication identity includes invocation, output name and key; attempt ID is provenance only. An identical repeat returns the original exact reference. A different encoded value or identity-bearing metadata for that key conflicts; tags are included in the comparison. Returning a reference means blob and catalog publication are committed, not merely queued.

**Proposed clarification to the lake design:** use explicit publication keys, rather than an incidental write ordinal. Concurrent publication makes an implicit ordinal fragile. The host can derive internal storage identities from the stable key while retaining the publication protocol in [data lake](data-lake.md).

An output declaration permits publication; it does not require a write. Publication and task completion are separate records. If publication commits and the task crashes, replay may recover the same reference. Existing artifacts remain visible with producer provenance even if the task later fails or is cancelled; readers can inspect producer state. They are not silently rolled back or called successful task results. Multi-artifact atomic batches and binary streaming are later APIs.

## Configuration, secrets and resource lifetimes

Application-specific clients are ordinary Context services. Their Layers consume validated non-secret configuration and host secret references. The handler need not receive passwords or an entire application configuration object. Non-secret configuration affecting behavior is pinned with the application revision; reading mutable process environment independently on each retry breaks that expectation.

Secrets resolve through the host SecretStore into Effect Redacted values and stay out of run input, outputs, progress and logs. Credential rotation may change the secret bytes without changing the pinned reference. This permits renewed access, not switching the operation's tenant/account identity during recovery. If an old reference cannot be resolved, report the failure rather than selecting another credential silently. Redaction is defense in depth, not protection from arbitrary trusted code deliberately exposing secrets.

Shared clients live in an application-revision Layer scope. Per-attempt resources use normal Effect scoping and finalizers. A Task can use `Effect.acquireRelease`; the runner owns the attempt Scope and closes it after settlement/interruption. Cleanup is bounded and does not compensate external business actions implicitly. The pinned [Effect implementation](../vendor/effect/packages/effect/src/Effect.ts) provides the resource primitives; Effectory must prove its attempt-scope wiring.

Cancellation interrupts the attempt and its scoped children. Daemon shutdown, user cancellation and deadlines are separate recorded causes. A disconnected CLI does not interrupt work. Avoid daemon fibers escaping the attempt scope; a task needing persistent background work should submit it through an explicit workflow design, not fork an untracked fiber. Task handlers cannot invoke other durable tasks or open durable waits in v0; compose those as visible graph nodes.

## Errors, progress and retry ownership

| Category | Contract |
| --- | --- |
| Declared domain error | Schema-encoded business failure; encourage tagged schema error classes |
| `TaskRuntimeError` | Fixed host failure union, e.g. artifact storage/publication conflict; separate from domain schema |
| Defect / invalid success encoding | Sanitized execution failure with diagnostics; never cast into the domain error |
| Cancellation / deadline | Control outcome, with bounded finalization and uncertainty handling |
| Uncertain external outcome | `NeedsAttention` unless the replay/reconciliation contract proves safe recovery |

Context methods may fail with `TaskRuntimeError` without forcing every task to add storage errors to its business schema. The run envelope preserves the category; the constructor must not widen arbitrary undeclared handler errors into this union. Initially support explicit `idempotent` or `manual` replay declarations. A bare `reconcile` string is insufficient until its handler/input/result protocol exists. Keep the earlier field name for compatibility in this pass, but document that `replay: "idempotent"` is an author/provider obligation, not an engine guarantee.

Durable retry policy belongs to the graph invocation. An `Effect.retry` inside a handler is an ordinary in-memory retry within one attempt; it resets on restart and can multiply external calls. Use it only deliberately within the same safety contract. Timeout/cancellation after sending a request does not prove the request was not applied. Avoid broad catches that turn interruption or defects into success.

Use normal Effect logging/spans; the host attaches invocation/attempt annotations. `context.progress({ message, completed?, total? })` is bounded, sanitized and best-effort. It cannot fail business work, may repeat on retry, and is not a checkpoint. Logs/progress cannot serve as evidence that an external effect committed.

## Test seam, scope and required proof

Propose `Task.test(task, { input })` as a one-attempt harness returning the decoded result plus captured publications/progress, while retaining the task's external service requirements. Tests provide fake clients through ordinary Layers. The harness supplies deterministic runtime context and an isolated test artifact store, performs the same boundary validation, and exposes recorded failures. It does not claim to test durable retries, restart or daemon behavior. A persistent runtime harness is separately required for those scenarios.

Named, persisted configured behavior instances remain outside initial scope. Use task/application service Layers for one registered definition. Multiple configurations of the same task identity in one application still need an explicit instance-identity design; `.provide` must not silently create one or resolve duplicate IDs by load order. This is a stated Swamp parity gap.

Before adoption, prove: contextual typing without self-reference; output-name/value checks; service requirements retained through Layers; codec round trips; domain vs runtime error separation; stable operation/publication keys across attempts; duplicate publication with changed data/metadata; attempt-scope interruption and cleanup; a crash after external success or artifact commit; and the test harness rejecting the same invalid boundaries as production. No such proof was run here.

The main tradeoffs are explicit callback context versus ambient runtime access, mandatory publication keys versus convenience, and deferring named integration instances/reconciliation until their identities and protocols are concrete.

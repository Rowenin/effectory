import { OperationError, terminal } from "@effectory/runtime/protocol";
import type { Outbox, Run, WaitReceipt } from "@effectory/runtime/protocol";
import { decode, encode } from "@offtree/effectory-sdk/internal/boundary";
import { snapshot, validate } from "@offtree/effectory-sdk/internal/tag-state";
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect";
import { DurableDeferred } from "effect/workflow";

import { Catalog } from "./catalog.ts";
import { ExecutionFailure } from "./execution-boundary.ts";
import { ExecutionResources } from "./execution-resources.ts";
import { waitDeclaration } from "./graph-execution.ts";
import { HostStore } from "./host-store.ts";
import type { SettleWait, Submit } from "./host-store.ts";
import { execution, notification, stopInvocations } from "./interpreter.ts";
import { Lake } from "./lake.ts";
import { validatePolicies } from "./policies.ts";
import { recoveryContinuation } from "./recovery-continuation.ts";
import { resolveReportPlan } from "./report-plan.ts";
import { reconcileReportSources } from "./report-reconciliation.ts";

function dispatch(intent: Outbox) {
  return Effect.gen(function* () {
    const store = yield* HostStore;
    const run = yield* store.getRun(intent.runId);
    if (intent.kind === "Dispatch") {
      if (run.status !== "Cancelling" && !terminal.has(run.status)) {
        if (run.kind === "workflow") {
          yield* store.registerWorkflowInvocation(
            run.runId,
            "[]",
            run.targetId
          );
        }
        const id = yield* execution.execute(
          { runId: run.runId },
          { discard: true }
        );
        yield* store.setEngineId(run.runId, id);
        const current = yield* store.getRun(run.runId);
        if (current.status === "Queued") {
          yield* store.project(run.runId, "Running");
        }
      }
    } else if (intent.kind === "Cancel") {
      yield* stopInvocations(run.runId);
      yield* run.engineId !== null && run.engineId !== ""
        ? execution.interrupt(run.engineId)
        : store.project(run.runId, "Cancelled", null, "Control");
    } else if (
      intent.waitId !== null &&
      intent.waitId !== "" &&
      run.engineId !== null &&
      run.engineId !== "" &&
      !terminal.has(run.status) &&
      run.status !== "Cancelling"
    ) {
      const wait = yield* store.getWait(intent.waitId);
      if ((yield* store.fenceReason(run.runId)) !== null) {
        yield* stopInvocations(run.runId);
      }
      const deferred = notification(wait.nodeId);
      yield* DurableDeferred.succeed(deferred, {
        token: DurableDeferred.tokenFromExecutionId(deferred, {
          executionId: run.engineId,
          workflow: execution,
        }),
        value: wait.waitId,
      });
    }
    yield* store.acknowledge(intent.id);
  });
}

function attentionIfOverdue(run: Run) {
  return Effect.gen(function* () {
    const store = yield* HostStore;
    const requestedAt = yield* store.fenceRequestedAt(run.runId);
    if (requestedAt === null || Date.now() < requestedAt + 2000) {
      return;
    }
    yield* store.appendEvent(
      run.runId,
      "finalization-stalled",
      "FinalizationStalled",
      {
        deadline: requestedAt + 2000,
        message:
          "Stopped run still has unfinished execution or resource cleanup",
      }
    );
    yield* store.project(run.runId, "NeedsAttention");
  });
}

function reconcile(run: Run) {
  return Effect.gen(function* () {
    if (run.engineId === null || run.engineId === "") {
      return;
    }
    const store = yield* HostStore;
    const resources = yield* ExecutionResources;
    if ((yield* store.fenceRequestedAt(run.runId)) !== null) {
      yield* stopInvocations(run.runId);
    }
    const result = yield* execution.poll(run.engineId);
    if (Option.isNone(result)) {
      yield* store.project(run.runId, "Running");
      yield* attentionIfOverdue(run);
      return;
    }
    if (result.value._tag === "Suspended") {
      // A suspended root can retain its last result while a child wakes.
      // project rechecks stop fences and manual holds in its transaction.
      yield* store.project(
        run.runId,
        resources.working(run.runId) > 0 ? "Running" : "Waiting"
      );
      yield* attentionIfOverdue(run);
      return;
    }
    const { exit } = result.value;
    if (
      resources.working(run.runId) > 0 ||
      resources.active(run.runId) > 0 ||
      (Exit.isFailure(exit) && !(yield* stopInvocations(run.runId)))
    ) {
      yield* attentionIfOverdue(run);
      return;
    }
    resources.release(run.runId);
    if (Exit.isSuccess(exit)) {
      yield* store.project(run.runId, "Succeeded", exit.value);
      return;
    }
    const stopped = yield* store.fenceReason(run.runId);
    if (stopped !== null) {
      const reason = yield* Schema.decodeUnknownEffect(ExecutionFailure)(
        stopped
      ).pipe(Effect.orDie);
      yield* store.project(
        run.runId,
        reason.outcome,
        reason.detail,
        reason.category
      );
      return;
    }
    const failure = Cause.findErrorOption(exit.cause);
    yield* Option.isSome(failure) && !Cause.hasDies(exit.cause)
      ? store.project(
          run.runId,
          failure.value.outcome,
          failure.value.detail,
          failure.value.category
        )
      : store.project(
          run.runId,
          "Failed",
          {
            category: "Defect",
            message: "Execution failed unexpectedly",
          },
          "Defect"
        );
  });
}

const invalidWaitPath = () =>
  new OperationError({
    code: "Unavailable",
    message: "Wait path is invalid",
  });
export const tick = Effect.gen(function* () {
  const store = yield* HostStore;
  yield* store.expire();
  yield* store.checkReconcile();
  for (const intent of yield* store.outbox()) {
    yield* dispatch(intent);
  }
  let after = "";
  for (;;) {
    const runs = yield* store.activeRuns(after);
    for (const run of runs) {
      yield* reconcile(run);
    }
    const last = runs.at(-1);
    if (runs.length < 200 || !last) {
      break;
    }
    after = last.runId;
  }
  yield* reconcileReportSources;
  yield* (yield* Lake).cleanupReadPins;
});

export const Runner = Context.Service<{
  readonly stopAccepting: Effect.Effect<void>;
  readonly settle: (
    request: SettleWait,
    principal: string
  ) => Effect.Effect<WaitReceipt, OperationError>;
  readonly submit: (
    request: Submit,
    principal: string
  ) => Effect.Effect<Run, OperationError>;
}>("effectory/Runner");

export const runnerLayer = Layer.effect(
  Runner,
  Effect.gen(function* () {
    const store = yield* HostStore;
    const catalog = yield* Catalog;
    let accepting = true;
    const recoveries = yield* recoveryContinuation;
    yield* tick.pipe(
      Effect.andThen(recoveries),
      Effect.catch(() => Effect.logWarning("Runner reconciliation will retry")),
      Effect.andThen(Effect.sleep("100 millis")),
      Effect.forever,
      Effect.forkScoped
    );
    return {
      settle: (request, principal) =>
        Effect.gen(function* () {
          const wait = yield* store.getWait(request.waitId, principal, true);
          const run = yield* store.getRun(wait.runId, principal);
          const application = yield* catalog.get(run.revision);
          const path = yield* Effect.try({
            catch: invalidWaitPath,
            try: (): unknown => JSON.parse(wait.nodeId),
          }).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Array(Schema.String))
            ),
            Effect.mapError(invalidWaitPath)
          );
          const node = waitDeclaration(
            application.registry,
            run.targetId,
            path
          );
          if (
            !node ||
            (node.kind !== "Approval" &&
              node.kind !== "Input" &&
              node.kind !== "Signal" &&
              node.kind !== "SignalRegistration")
          ) {
            return yield* new OperationError({
              code: "Unavailable",
              message: "Pinned wait declaration is unavailable",
            });
          }
          const codec = node.schema;
          return yield* store.settle(request, principal, (input) =>
            codec ? encode(codec, decode(codec, input)) : input
          );
        }).pipe(Effect.scoped),
      stopAccepting: Effect.sync(() => {
        accepting = false;
      }),
      submit: (request, principal) =>
        Effect.gen(function* () {
          const previous = yield* store.lookupSubmission(request, principal);
          if (previous) {
            return previous;
          }
          if (!accepting) {
            return yield* new OperationError({
              code: "Unavailable",
              message: "Daemon is draining",
            });
          }
          const application = yield* catalog.get(request.revision);
          const definition =
            request.kind === "task"
              ? application.registry.tasks.get(request.targetId)
              : application.registry.workflows.get(request.targetId)
                  ?.definition;
          if (!definition) {
            return yield* new OperationError({
              code: "NotFound",
              message: "Definition was not found",
            });
          }
          const resolvedTags = yield* Effect.try({
            catch: (cause) =>
              new OperationError({
                code: "InvalidInput",
                message: `${String(cause).slice(0, 1900)}; see workflow describe for declared tags`,
              }),
            try: () => {
              const tags = snapshot({
                ...(definition.kind === "Workflow" ? definition.tags : {}),
                ...request.tags,
              });
              if (definition.kind === "Workflow") {
                validate(tags, definition.tagSchemas);
              }
              return tags;
            },
          });
          yield* Effect.try({
            catch: () =>
              new OperationError({
                code: "InvalidInput",
                message: "Input or execution policy is invalid or unsupported",
              }),
            try: () => {
              decode(definition.inputSchema, request.input);
              if (request.kind === "workflow") {
                validatePolicies(application.registry, request.targetId);
              }
            },
          });
          const reports = yield* Effect.try({
            catch: (cause) =>
              new OperationError({
                code: "InvalidInput",
                message: String(cause).slice(0, 1900),
              }),
            try: () =>
              resolveReportPlan(
                application.registry,
                request.kind,
                request.targetId,
                request.reportSelection ?? {}
              ),
          });
          return yield* store.submit(
            {
              ...request,
              reportPlan: reports.plan,
              resolvedReportSelection: reports.decision,
              resolvedTags,
            },
            application.revision,
            principal
          );
        }).pipe(Effect.scoped),
    };
  })
);

import { Effect } from "effect";

import { HostStore } from "./host-store.ts";
import { leafExecution, pollWorkflowInvocation } from "./interpreter.ts";
import {
  normalizeInvocation,
  normalizeWorkflowInvocation,
  outcomeCategory,
} from "./invocation-outcome.ts";

/** One native poll per logical invocation, never one per attached report. */
export const reconcileReportSources = Effect.gen(function* () {
  const store = yield* HostStore;
  for (const row of yield* store.reportScan()) {
    if (row.invocationId === null) {
      continue;
    }
    const { invocationId } = row;
    yield* Effect.gen(function* () {
      const facts = yield* store.invocationFacts(row.sourceRunId);
      const workflow =
        row.source.targetKind === "workflow"
          ? yield* store.reportWorkflowDetails(row.sourceRunId, invocationId)
          : null;
      const native = workflow
        ? yield* pollWorkflowInvocation(
            yield* store.getRun(row.sourceRunId),
            workflow.path
          )
        : yield* leafExecution.poll(invocationId);
      const result = workflow
        ? normalizeWorkflowInvocation(native, facts, workflow.entered === 1)
        : normalizeInvocation(native, facts);
      if (result._tag === "Unresolved") {
        yield* store.reportObservationError(
          row.sourceId,
          "Unavailable: terminal source still has a suspended native invocation"
        );
      } else if (result._tag === "NoNativeExecution") {
        yield* store.reportSettleSource(
          row.sourceId,
          null,
          null,
          workflow ? "NotStarted" : "NoNativeExecution"
        );
      } else if (result._tag === "Complete") {
        const { attemptCount } = workflow
          ? { attemptCount: workflow.entered }
          : yield* store.reportInvocationDetails(row.sourceRunId, invocationId);
        yield* store.reportSettleSource(
          row.sourceId,
          result.status,
          outcomeCategory(result.outcome),
          result.status !== "Succeeded" && attemptCount === 0
            ? "NotStarted"
            : null
        );
      } else {
        yield* store.reportObservationError(row.sourceId, null);
      }
    }).pipe(
      Effect.catchCause(() =>
        store.reportObservationError(
          row.sourceId,
          "Unavailable: report source observation will retry"
        )
      ),
      Effect.ensuring(store.reportAdvance(row.sourceSeq).pipe(Effect.orDie))
    );
    // Bound synchronous work between cooperative scheduling points, including
    // hot native replies. The durable cursor prevents a busy early source
    // from starving later sources across ticks and daemon restarts.
    yield* Effect.yieldNow;
  }
  for (const row of yield* store.reportPendingSources("Ready")) {
    yield* store.reportMaterialize(row.sourceId);
    yield* Effect.yieldNow;
  }
  yield* store.reportCancellationDrain();
  yield* Effect.yieldNow;
  for (let slot = 0; slot < 4; slot += 1) {
    const promoted = yield* store.reportPromote().pipe(
      Effect.catchIf(
        (error) =>
          error.code === "LimitExceeded" || error.code === "Unavailable",
        () => Effect.succeed(null)
      )
    );
    if (promoted === null) {
      break;
    }
  }
});

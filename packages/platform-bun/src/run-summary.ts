import { OperationError } from "@effectory/runtime/protocol";
import { RunSummarizeReply } from "@effectory/runtime/report-protocol";
import { Clock, Effect } from "effect";

import { HostStore } from "./host-store.ts";
import { normalizeInvocation, outputFields } from "./invocation-outcome.ts";
import { nativeTaskResult } from "./native-history.ts";

/** A bounded read-time summary: never persist Markdown or copy inputs/results into it. */
export const runSummary = (runId: string, principal: string) =>
  Effect.gen(function* () {
    const store = yield* HostStore;
    const run = yield* store.getRun(runId, principal);
    const started = yield* Clock.currentTimeMillis;
    const invocations = {
      Cancelled: 0,
      Failed: 0,
      Pending: 0,
      Rejected: 0,
      Succeeded: 0,
      Suspended: 0,
      TimedOut: 0,
      total: 0,
    };
    const failures: (typeof RunSummarizeReply.Type)["data"]["failures"][number][] =
      [];
    let failureCount = 0;
    let cursor: string | undefined;
    let more = true;
    while (more) {
      const page = yield* store.reportInvocationScan(runId, principal, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const facts = yield* store.invocationFacts(runId);
      for (const row of page.rows.slice(0, page.limit)) {
        if (
          invocations.total === 10_000 ||
          (yield* Clock.currentTimeMillis) - started >= 5000
        ) {
          return yield* new OperationError({
            code: "QueryBudgetExceeded",
            message: "Run summary exceeded 10000 invocations or five seconds",
          });
        }
        const native = yield* nativeTaskResult(row.engineId);
        const { status } = outputFields(normalizeInvocation(native, facts));
        invocations[status] += 1;
        invocations.total += 1;
        if (!["Pending", "Suspended", "Succeeded"].includes(status)) {
          failureCount += 1;
          if (failures.length < 20) {
            const path = [...row.pathText];
            failures.push({
              invocationId: row.engineId,
              pathPreview: {
                text: path.slice(0, 2048).join(""),
                truncated: path.length > 2048,
              },
              status,
              taskId: row.taskId,
            });
          }
        }
        yield* Effect.yieldNow;
      }
      const last = page.rows.slice(0, page.limit).at(-1);
      more = page.rows.length > page.limit && last !== undefined;
      cursor = more && last ? page.cursor(last.position) : undefined;
    }
    const reports = yield* store.reportAggregate(runId, principal);
    if ((yield* Clock.currentTimeMillis) - started >= 5000) {
      return yield* new OperationError({
        code: "QueryBudgetExceeded",
        message: "Run summary exceeded five seconds",
      });
    }
    const data = {
      failures,
      invocations,
      observedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      reports,
      runId,
      sampleTruncated: failureCount > 20,
      status: run.status,
    };
    return RunSummarizeReply.make({
      data,
      markdown: [
        `# Run ${runId}`,
        "",
        `Status: ${run.status}`,
        `Invoked tasks: ${invocations.total}; succeeded: ${invocations.Succeeded}; failed or stopped: ${failureCount}`,
        `Reports: ${reports.total}; succeeded: ${reports.Succeeded}; failed: ${reports.Failed}; cancelled: ${reports.Cancelled}`,
        "",
        ...failures.map(
          (item) =>
            `- ${item.status}: ${JSON.stringify(item.taskId)} (${item.invocationId}) at ${JSON.stringify(item.pathPreview.text)}${item.pathPreview.truncated ? " [path truncated]" : ""}`
        ),
        ...(failureCount > 20
          ? ["Failure sample limited to 20 invocations."]
          : []),
        "",
        `Inspect: effectory run get ${runId}`,
        `Outputs: effectory run outputs ${runId}`,
        `Reports: effectory report list ${runId}`,
      ].join("\n"),
    });
  });

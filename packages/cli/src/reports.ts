/* oxlint-disable promise/avoid-new, promise/prefer-await-to-callbacks -- Node stdout is a callback boundary. */
import type { connect } from "@effectory/platform-bun/client";
import type { Run } from "@effectory/runtime/protocol";
import { OperationError, terminal } from "@effectory/runtime/protocol";
import type {
  ReportAggregate,
  ReportRecord,
} from "@effectory/runtime/report-protocol";
import { Effect, FileSystem } from "effect";

type Client = Effect.Success<ReturnType<typeof connect>>;
const settled = new Set([
  "Succeeded",
  "Failed",
  "Cancelled",
  "NotApplicable",
  "NeedsAttention",
]);
export const reportExit = (status: (typeof ReportRecord.Type)["status"]) => {
  if (status === "Succeeded" || status === "NotApplicable") {
    return 0;
  }
  return status === "Failed" || status === "Cancelled" ? 1 : 4;
};
export const aggregateExit = (value: typeof ReportAggregate.Type) => {
  if (value.NeedsAttention > 0) {
    return 4;
  }
  return value.Failed + value.Cancelled > 0 ? 1 : 0;
};
export const reportsPreflight = <E, R>(client: {
  readonly SystemStatus: (
    request: Record<string, never>
  ) => Effect.Effect<{ readonly capabilities: readonly string[] }, E, R>;
}) =>
  Effect.gen(function* () {
    const status = yield* client.SystemStatus({});
    if (!status.capabilities.includes("reports.v1")) {
      return yield* new OperationError({
        code: "Unavailable",
        message:
          "This daemon does not support reports. Restart it with effectory daemon stop, then effectory daemon start.",
      });
    }
    return status;
  });

/** The same unsafe Unicode classes as live console, but preserve document layout. */
export const safeMarkdown = (text: string) =>
  text.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, (character) => {
    if (character === "\n" || character === "\t") {
      return character;
    }
    const point = character.codePointAt(0) ?? 0;
    return point <= 0xff_ff
      ? `\\u${point.toString(16).padStart(4, "0")}`
      : `\\u{${point.toString(16)}}`;
  });
export const reportText = (text: string, output?: string) =>
  Effect.gen(function* () {
    if (output !== undefined) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(output, text, { flag: "wx" }).pipe(
        Effect.mapError(
          (error) =>
            new OperationError({
              code:
                error.reason._tag === "AlreadyExists"
                  ? "Conflict"
                  : "Unavailable",
              message: `Cannot create report output ${output}: ${error.message}`,
            })
        )
      );
      return;
    }
    const body = process.stdout.isTTY ? safeMarkdown(text) : text;
    yield* Effect.tryPromise({
      catch: () =>
        new OperationError({
          code: "Unavailable",
          message: "Cannot write report output",
        }),
      try: async () =>
        await new Promise<void>((resolve, reject) => {
          const failed = (error: Error) => reject(error);
          process.stdout.once("error", failed);
          try {
            process.stdout.write(body, (error) => {
              if (error) {
                reject(error);
              } else {
                process.stdout.removeListener("error", failed);
                resolve();
              }
            });
          } catch (error) {
            process.stdout.removeListener("error", failed);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    });
  });

export const waitReport = (client: Client, reportId: string) =>
  Effect.gen(function* () {
    while (true) {
      const reply = yield* client.ReportGet({ reportId });
      if (settled.has(reply.record.status)) {
        return reply;
      }
      yield* Effect.sleep("250 millis");
    }
  });
export const waitReports = (client: Client, runId: string) =>
  Effect.gen(function* () {
    while (true) {
      const run = yield* client.RunGet({ runId });
      if (terminal.has(run.status)) {
        break;
      }
      const attention =
        run.status === "NeedsAttention" ||
        (run.status === "Waiting" &&
          (yield* client.WaitList({ limit: 1, runId, status: "Open" })).items
            .length > 0);
      if (attention) {
        const current = yield* client.RunGet({ runId });
        if (
          current.status === "NeedsAttention" ||
          current.status === "Waiting"
        ) {
          return {
            aggregate: (yield* client.RunReports({ limit: 1, runId }))
              .aggregate,
            code: 4,
          };
        }
      }
      yield* Effect.sleep("250 millis");
    }
    while (true) {
      const { aggregate } = yield* client.RunReports({ limit: 1, runId });
      if (
        aggregate.WaitingSource + aggregate.Queued + aggregate.Running ===
        0
      ) {
        return { aggregate, code: aggregateExit(aggregate) };
      }
      yield* Effect.sleep("250 millis");
    }
  });

export function runOrigin(run: Pick<Run, "report" | "schedule">) {
  if (run.report !== undefined) {
    return "report";
  }
  if (run.schedule !== undefined) {
    return "schedule";
  }
  return "manual";
}

import { OperationError } from "@effectory/runtime/protocol";
import type { RecoveryAssessment } from "@effectory/runtime/recovery-protocol";
import {
  RecoveryAssessmentRequest,
  RecoveryRequest,
} from "@effectory/runtime/recovery-protocol";
import { Effect, Option, Schema } from "effect";

export function recoveryRequest(config: {
  readonly id: string;
  readonly authorize: Option.Option<string>;
  readonly acknowledge: boolean;
  readonly cursor: Option.Option<string>;
  readonly limit: Option.Option<number>;
  readonly requestKey: Option.Option<string>;
  readonly reason: Option.Option<string>;
}) {
  return Effect.try({
    catch: () =>
      new OperationError({
        code: "InvalidInput",
        message:
          "Use run recover <id> to assess, or --authorize <token> --acknowledge-reexecution to authorize. Do not combine paging and mutation flags.",
      }),
    try: () => {
      if (Option.isSome(config.authorize)) {
        if (
          !config.acknowledge ||
          Option.isSome(config.cursor) ||
          Option.isSome(config.limit)
        ) {
          throw new Error("Invalid flags");
        }
        return {
          _tag: "Authorize",
          request: Schema.decodeUnknownSync(RecoveryRequest)({
            acknowledgeReexecution: true,
            requestKey: Option.getOrElse(config.requestKey, () =>
              crypto.randomUUID()
            ),
            runId: config.id,
            token: config.authorize.value,
            ...(Option.isSome(config.reason)
              ? { reason: config.reason.value }
              : {}),
          }),
        } as const;
      }
      if (
        config.acknowledge ||
        Option.isSome(config.requestKey) ||
        Option.isSome(config.reason)
      ) {
        throw new Error("Missing token");
      }
      return {
        _tag: "Assess",
        request: Schema.decodeUnknownSync(RecoveryAssessmentRequest)({
          runId: config.id,
          ...(Option.isSome(config.cursor)
            ? { cursor: config.cursor.value }
            : {}),
          ...(Option.isSome(config.limit) ? { limit: config.limit.value } : {}),
        }),
      } as const;
    },
  });
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const recoveryRetry = (request: typeof RecoveryRequest.Type) =>
  `Recovery delivery is uncertain. Retry: effectory run recover ${quote(request.runId)} --authorize ${quote(request.token)} --acknowledge-reexecution --request-key ${quote(request.requestKey)}. Repeat the same --reason separately if supplied.`;
export function recoveryGuidance(assessment: typeof RecoveryAssessment.Type) {
  return `${assessment.state}: ${assessment.reason}\nShowing ${assessment.entries.length} of ${assessment.total} uncertain entries${assessment.nextCursor ? " (more pages)" : ""}.\nAll entries in this assessment are authorized together, including entries on other pages. External actions may repeat. Existing publications do not prove success.\nLeaves still restarting may add entries later; they are never covered by an earlier token. Reassess when NeedsAttention returns.\nAuthorized re-entry gets a fresh attempt window: min(entryStart + attemptTimeout, absoluteDeadline). Workflow deadlines do not reset.`;
}

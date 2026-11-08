import { OperationError } from "@effectory/runtime/protocol";
import { ReportSearchRequest } from "@effectory/runtime/report-protocol";
import { Effect, Schema } from "effect";

import { parseTags } from "./tags.ts";

export const searchPreflight = <E, R>(
  client: {
    readonly SystemStatus: (
      request: Record<string, never>
    ) => Effect.Effect<{ readonly capabilities: readonly string[] }, E, R>;
  },
  workflowInvocations = false
) =>
  Effect.gen(function* () {
    const status = yield* client.SystemStatus({});
    if (
      !status.capabilities.includes("reports.search.v1") ||
      (workflowInvocations &&
        !status.capabilities.includes("reports.workflow-invocations.v1"))
    ) {
      return yield* new OperationError({
        code: "Unavailable",
        message:
          "This daemon does not support report search. Restart a compatible build with effectory daemon stop, then effectory daemon start.",
      });
    }
  });

const invalidSearch = (cause: unknown) =>
  cause instanceof OperationError
    ? cause
    : new OperationError({
        code: "InvalidInput",
        message: "Invalid report search filters",
      });
export function searchRequest(
  value: Record<string, unknown>,
  tags: readonly string[]
) {
  return Effect.try({ catch: invalidSearch, try: () => parseTags(tags) }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeEffect(ReportSearchRequest)(
        { ...value, tags: parsed },
        { onExcessProperty: "error" }
      )
    ),
    Effect.mapError(invalidSearch)
  );
}

// Bash/zsh ANSI-C quoting preserves arguments while keeping controls off the terminal.
const quote = (value: string) =>
  `$'${value.replaceAll(
    /[\\'\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu,
    (character) => {
      if (character === "\\" || character === "'") {
        return `\\${character}`;
      }
      const point = character.codePointAt(0) ?? 0;
      return point <= 0xff_ff
        ? `\\u${point.toString(16).padStart(4, "0")}`
        : `\\U${point.toString(16).padStart(8, "0")}`;
    }
  )}'`;

export function searchContinuation(
  request: typeof ReportSearchRequest.Type,
  cursor: string,
  repository: string
) {
  const args = [
    "effectory",
    "--repository",
    quote(repository),
    "report",
    "search",
  ];
  const names = [
    ["attachmentId", "attachment"],
    ["createdAfter", "created-after"],
    ["createdBefore", "created-before"],
    ["reporterId", "reporter"],
    ["runId", "run"],
    ["scope", "scope"],
    ["sourceWorkflowId", "source-workflow"],
    ["taskId", "task"],
    ["workflowId", "workflow"],
  ] as const;
  for (const [key, flag] of names) {
    const value = request[key];
    if (value !== undefined) {
      args.push(`--${flag}`, quote(value));
    }
  }
  for (const status of request.statuses ?? []) {
    args.push("--status", quote(status));
  }
  for (const [key, value] of Object.entries(request.tags ?? {})) {
    args.push("--tag", quote(`${key}=${value}`));
  }
  if (request.history === true) {
    args.push("--history");
  }
  args.push("--limit", String(request.limit ?? 50), "--cursor", quote(cursor));
  if (request.query !== undefined) {
    args.push("--", quote(request.query));
  }
  return args.join(" ");
}

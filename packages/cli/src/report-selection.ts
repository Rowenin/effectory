import { OperationError } from "@effectory/runtime/protocol";
import { normalizeSelection } from "@offtree/effectory-sdk/internal/report-selection-schema";
import { Effect, Option } from "effect";
import { Flag } from "effect/cli";

import { parseTags } from "./tags.ts";

export const selectionFlags = {
  reportOnly: Flag.String("report").pipe(
    Flag.atMost(128),
    Flag.withDescription(
      "Include attachment ID; required reports remain (repeatable)"
    )
  ),
  reportOnlyTags: Flag.String("report-tag").pipe(
    Flag.atMost(32),
    Flag.withDescription("Include attachments matching every KEY=VALUE")
  ),
  reportSkip: Flag.String("skip-report").pipe(
    Flag.atMost(128),
    Flag.withDescription("Exclude optional attachment ID (repeatable)")
  ),
  reportSkipAll: Flag.Boolean("skip-reports").pipe(
    Flag.optional,
    Flag.withDescription("Skip all optional reports; required reports remain")
  ),
  reportSkipTags: Flag.String("skip-report-tag").pipe(
    Flag.atMost(32),
    Flag.withDescription(
      "Exclude optional attachments matching every KEY=VALUE"
    )
  ),
};
export interface SelectionFlags {
  readonly reportOnly: readonly string[];
  readonly reportOnlyTags: readonly string[];
  readonly reportSkip: readonly string[];
  readonly reportSkipAll: Option.Option<boolean>;
  readonly reportSkipTags: readonly string[];
}
export function selectionFor<E, R>(
  client: {
    readonly SystemStatus: (
      request: Record<never, never>
    ) => Effect.Effect<{ readonly capabilities: readonly string[] }, E, R>;
  },
  flags: SelectionFlags
) {
  return Effect.gen(function* () {
    const used =
      flags.reportOnly.length ||
      flags.reportOnlyTags.length ||
      flags.reportSkip.length ||
      flags.reportSkipTags.length ||
      Option.isSome(flags.reportSkipAll);
    if (!used) {
      return {};
    }
    const reportSelection = yield* Effect.try({
      catch: (cause) =>
        new OperationError({
          code: "InvalidInput",
          message: `Invalid report selection: ${String(cause).slice(0, 1500)}`,
        }),
      try: () =>
        normalizeSelection({
          only: flags.reportOnly,
          onlyTags: parseTags(flags.reportOnlyTags, "--report-tag"),
          skip: flags.reportSkip,
          skipAll: Option.getOrElse(flags.reportSkipAll, () => false),
          skipTags: parseTags(flags.reportSkipTags, "--skip-report-tag"),
        }),
    });
    const status = yield* client.SystemStatus({});
    if (!status.capabilities.includes("reports.selection.v1")) {
      return yield* new OperationError({
        code: "Unavailable",
        message:
          "This daemon does not support report selection. Restart a compatible build with effectory daemon stop, then effectory daemon start.",
      });
    }
    return { reportSelection };
  });
}

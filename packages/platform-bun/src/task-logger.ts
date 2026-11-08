import { checkJsonBudget } from "@offtree/effectory-sdk/internal/boundary";
import { scrub } from "@offtree/effectory-sdk/internal/vault-tracker";
import type { Tracker } from "@offtree/effectory-sdk/internal/vault-tracker";
import { Cause, Logger, Option, Schema } from "effect";

import type { HostStore } from "./host-store.ts";

function message(value: unknown, tracker?: Tracker): Schema.Json {
  try {
    const normalized =
      value instanceof Error
        ? {
            message: scrub(tracker, value.message).slice(0, 2000),
            name: scrub(tracker, value.name).slice(0, 200),
          }
        : value;
    checkJsonBudget(normalized, { bytes: 2048, depth: 8, values: 256 });
    const serialized = JSON.stringify(
      Schema.decodeUnknownSync(Schema.Json)(normalized)
    );
    const safe = scrub(tracker, serialized);
    return safe === serialized
      ? Schema.decodeUnknownSync(Schema.Json)(JSON.parse(serialized))
      : safe;
  } catch {
    return "[Log value omitted: exceeds JSON limits or is not JSON]";
  }
}

export function taskLogger(
  store: typeof HostStore.Service,
  runId: string,
  nodeId: string,
  attempt: number,
  tracker?: Tracker
) {
  return Logger.make((options: Logger.Options<unknown>) => {
    const error = Cause.findErrorOption(options.cause);
    store.telemetry(runId, `log/${crypto.randomUUID()}`, "Log", {
      attempt,
      error: Option.isSome(error) ? message(error.value, tracker) : null,
      level: options.logLevel,
      message: message(options.message, tracker),
      nodeId,
    });
  });
}

import { checkJsonBudget } from "@effectory/core/internal/boundary";
import { Cause, Logger, Option, Schema } from "effect";

import type { HostStore } from "./host-store.ts";

function message(value: unknown): Schema.Json {
  try {
    const normalized =
      value instanceof Error
        ? {
            message: value.message.slice(0, 2000),
            name: value.name.slice(0, 200),
          }
        : value;
    checkJsonBudget(normalized, { bytes: 2048, depth: 8, values: 256 });
    return Schema.decodeUnknownSync(Schema.Json)(normalized);
  } catch {
    return "[Log value omitted: exceeds JSON limits or is not JSON]";
  }
}

export function taskLogger(
  store: typeof HostStore.Service,
  runId: string,
  nodeId: string,
  attempt: number
) {
  return Logger.make((options: Logger.Options<unknown>) => {
    const error = Cause.findErrorOption(options.cause);
    store.telemetry(runId, `log/${crypto.randomUUID()}`, "Log", {
      attempt,
      error: Option.isSome(error) ? message(error.value) : null,
      level: options.logLevel,
      message: message(options.message),
      nodeId,
    });
  });
}

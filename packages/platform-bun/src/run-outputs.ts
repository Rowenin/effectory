import type {
  OutputListRequest,
  RunOutput,
} from "@effectory/runtime/history-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Cause, Effect, Exit, Option } from "effect";

import { HostStore } from "./host-store.ts";
import { leafExecution } from "./interpreter.ts";

/** Reads native Effect outcomes; host invocation records contain no task results. */
export const runOutputs = (
  request: typeof OutputListRequest.Type,
  principal: string
) =>
  Effect.gen(function* () {
    const store = yield* HostStore;
    const page = yield* store.invocationScan(request, principal);
    const items: (typeof RunOutput.Type)[] = [];
    let bytes = 0;
    let position = 0;
    let more = false;
    for (const row of page.rows) {
      if (items.length >= page.limit) {
        more = true;
        break;
      }
      const state = yield* leafExecution.poll(row.engineId);
      let item: typeof RunOutput.Type = {
        error: null,
        nodeId: row.nodeId,
        result: null,
        status: "Pending",
        taskId: row.taskId,
      };
      if (Option.isSome(state)) {
        if (state.value._tag === "Suspended") {
          item = { ...item, status: "Suspended" };
        } else if (Exit.isSuccess(state.value.exit)) {
          item = {
            ...item,
            result: state.value.exit.value,
            status: "Succeeded",
          };
        } else {
          const failure = Cause.findErrorOption(state.value.exit.cause);
          item = Option.isSome(failure)
            ? {
                ...item,
                error: {
                  category: failure.value.category,
                  detail: failure.value.detail,
                },
                status: failure.value.outcome,
              }
            : {
                ...item,
                error: {
                  category: "Defect",
                  message: "Task execution failed unexpectedly",
                },
                status: "Failed",
              };
        }
      }
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > 2_097_152) {
        more = true;
        break;
      }
      const { position: nextPosition } = row;
      position = nextPosition;
      items.push(item);
    }
    if (more && items.length === 0) {
      return yield* new OperationError({
        code: "LimitExceeded",
        message: "Task output exceeds 2 MiB inspection page",
      });
    }
    return {
      cursor: more ? page.cursor(position) : null,
      items,
      snapshot: page.snapshot,
    };
  });

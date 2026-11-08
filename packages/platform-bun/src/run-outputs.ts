import type {
  OutputListRequest,
  RunOutput,
} from "@effectory/runtime/history-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Effect } from "effect";

import { HostStore } from "./host-store.ts";
import { normalizeInvocation, outputFields } from "./invocation-outcome.ts";
import { nativeTaskResult } from "./native-history.ts";

/** Reads native Effect outcomes; host invocation records contain no task results. */
export const runOutputs = (
  request: typeof OutputListRequest.Type,
  principal: string
) =>
  Effect.gen(function* () {
    const store = yield* HostStore;
    const page = yield* store.invocationScan(request, principal);
    const facts = yield* store.invocationFacts(request.runId);
    const items: (typeof RunOutput.Type)[] = [];
    let bytes = 0;
    let position = 0;
    let more = false;
    for (const row of page.rows) {
      if (items.length >= page.limit) {
        more = true;
        break;
      }
      const state = yield* nativeTaskResult(row.engineId);
      const item: typeof RunOutput.Type = {
        ...outputFields(normalizeInvocation(state, facts)),
        nodeId: row.nodeId,
        taskId: row.taskId,
      };
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

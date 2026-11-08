import { Rpc, RpcGroup } from "effect/rpc";

import { RunWatchFrame, RunWatchRequest } from "./history-protocol.ts";
import { OperationError } from "./protocol.ts";

export { RunWatchFrame, RunWatchRequest } from "./history-protocol.ts";
export const RunWatch = Rpc.make("RunWatch", {
  error: OperationError,
  payload: RunWatchRequest,
  stream: true,
  success: RunWatchFrame,
});
export const WatchPlane = RpcGroup.make(RunWatch);

import { Rpc, RpcGroup } from "effect/rpc";

import { DownloadFrame, DownloadRequest } from "./lake-protocol.ts";
import { OperationError } from "./protocol.ts";

/** Separate framed transport; the JSON control plane remains compatible. */
export const ContentPlane = RpcGroup.make(
  Rpc.make("LakeDownload", {
    error: OperationError,
    payload: DownloadRequest,
    stream: true,
    success: DownloadFrame,
  })
);

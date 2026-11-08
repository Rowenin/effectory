import { OperationError } from "@effectory/runtime/protocol";
import { WatchPlane } from "@effectory/runtime/watch-rpc";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

import { connectionConfig } from "./connection-config.ts";

/** Internal constructor lets the CLI share its status preflight with tag checks. */
export const createWatchClient = (
  repository: string,
  status: {
    readonly capabilities: readonly string[];
    readonly instanceId: string;
  }
) =>
  Effect.gen(function* () {
    const config = yield* connectionConfig(repository);
    if (!status.capabilities.includes("run.watch.stream.v1")) {
      return yield* new OperationError({
        code: "Unavailable",
        message:
          "The running daemon does not support run.watch.stream.v1. Restart it with this binary (effectory daemon stop, then effectory daemon start).",
      });
    }
    if (status.instanceId !== config.instanceId) {
      return yield* new OperationError({
        code: "Conflict",
        message: "Daemon instance changed during watch connection",
      });
    }
    const protocol = RpcClient.layerProtocolHttp({
      transformClient: (client) =>
        HttpClient.mapRequest(
          client,
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${config.token}`,
            "x-effectory-protocol": "1",
            "x-effectory-repository": config.repositoryId,
          })
        ),
      url: new URL("/rpc/watch", config.url).href,
    }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(
        RpcSerialization.layerNdjsonWith({ maxBufferSize: 2_097_152 })
      )
    );
    const context = yield* Layer.build(protocol);
    return yield* RpcClient.make(WatchPlane).pipe(
      Effect.provideContext(context)
    );
  });

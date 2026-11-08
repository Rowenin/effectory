import { ContentPlane } from "@effectory/runtime/content-rpc";
import { OperationError } from "@effectory/runtime/protocol";
import { ControlPlane } from "@effectory/runtime/rpc";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

import { connectionConfig } from "./connection-config.ts";
import { createWatchClient } from "./watch-client.ts";

export const connect = (repository: string) =>
  Effect.gen(function* () {
    const config = yield* connectionConfig(repository);
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
      url: config.url,
    }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(RpcSerialization.layerJson)
    );
    const context = yield* Layer.build(protocol);
    const client = yield* RpcClient.make(ControlPlane).pipe(
      Effect.provideContext(context)
    );
    const hello = yield* client.SystemHello({
      clientVersion: "0.0.0",
      protocolMajor: 1,
      repositoryId: config.repositoryId,
    });
    if (hello.instanceId !== config.instanceId) {
      return yield* new OperationError({
        code: "Conflict",
        message: "Daemon instance changed during connection",
      });
    }
    return client;
  });

/** Capability-gated streaming client using the same validated daemon identity. */
export const connectContent = (repository: string) =>
  Effect.gen(function* () {
    const config = yield* connectionConfig(repository);
    const control = yield* connect(repository);
    const status = yield* control.SystemStatus({});
    if (!status.capabilities.includes("lake.bytes.v1")) {
      return yield* new OperationError({
        code: "Unavailable",
        message:
          "The daemon does not support lake.bytes.v1; upgrade and restart it",
      });
    }
    if (status.instanceId !== config.instanceId) {
      return yield* new OperationError({
        code: "Conflict",
        message: "Daemon instance changed during content connection",
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
      url: new URL("/rpc/content", config.url).href,
    }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(
        RpcSerialization.layerNdjsonWith({ maxBufferSize: 131_072 })
      )
    );
    const context = yield* Layer.build(protocol);
    return yield* RpcClient.make(ContentPlane).pipe(
      Effect.provideContext(context)
    );
  });

/** Scope owns the live observer connection; old daemons fail before streaming. */
export const connectWatch = (repository: string) =>
  Effect.gen(function* () {
    const control = yield* connect(repository);
    const status = yield* control.SystemStatus({});
    return yield* createWatchClient(repository, status);
  });

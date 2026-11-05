import { readFileSync } from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { ControlPlane } from "@effectory/runtime/rpc";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

import { Credentials, Endpoint } from "./daemon.ts";

export const connect = (repository: string) =>
  Effect.gen(function* () {
    const config = yield* Effect.try({
      catch: () =>
        new OperationError({
          code: "Unavailable",
          message: "Daemon connection metadata is unavailable",
        }),
      try: () => {
        const directory = path.join(repository, ".effectory");
        const credentials = Schema.decodeUnknownSync(Credentials)(
          JSON.parse(
            readFileSync(path.join(directory, "credentials.json"), "utf-8")
          )
        );
        const endpoint = Schema.decodeUnknownSync(Endpoint)(
          JSON.parse(readFileSync(path.join(directory, "daemon.json"), "utf-8"))
        );
        const url = new URL(endpoint.url);
        if (
          url.protocol !== "http:" ||
          url.hostname !== "127.0.0.1" ||
          url.pathname !== "/rpc"
        ) {
          throw new Error("Invalid endpoint");
        }
        return { ...credentials, ...endpoint };
      },
    });
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

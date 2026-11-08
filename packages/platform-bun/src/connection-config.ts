import { readFileSync } from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import { Endpoint } from "./daemon.ts";
import { readStoredCredentials } from "./runtime-storage-format.ts";

const unavailable = () =>
  new OperationError({
    code: "Unavailable",
    message: "Daemon connection metadata is unavailable",
  });

export const connectionConfig = (repository: string) =>
  Effect.gen(function* () {
    const { credentials, raw } = yield* Effect.try({
      catch: unavailable,
      try: () => ({
        credentials: readStoredCredentials(repository),
        raw: JSON.parse(
          readFileSync(
            path.join(repository, ".effectory", "daemon.json"),
            "utf-8"
          )
        ) as unknown,
      }),
    });
    const endpoint = yield* Schema.decodeUnknownEffect(Endpoint)(raw);
    return yield* Effect.try({
      catch: unavailable,
      try: () => {
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
  }).pipe(Effect.mapError(unavailable));

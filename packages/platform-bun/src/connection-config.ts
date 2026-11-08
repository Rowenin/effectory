import { readFileSync } from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import { Endpoint } from "./daemon.ts";
import { readStoredCredentials } from "./runtime-storage-format.ts";

export const connectionConfig = (repository: string) =>
  Effect.try({
    catch: () =>
      new OperationError({
        code: "Unavailable",
        message: "Daemon connection metadata is unavailable",
      }),
    try: () => {
      const directory = path.join(repository, ".effectory");
      const credentials = readStoredCredentials(repository);
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

import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Hello, ServerHello, ServerStatus } from "@effectory/runtime/rpc";
import { Effect, Layer } from "effect";
import { HttpEffect } from "effect/http";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";

import { download } from "../src/download.ts";

const OldControl = RpcGroup.make(
  Rpc.make("SystemHello", {
    error: OperationError,
    payload: Hello,
    success: ServerHello,
  }),
  Rpc.make("SystemStatus", {
    error: OperationError,
    payload: {},
    success: ServerStatus,
  })
);

test("old daemon is refused before a content request or temporary file exists", async () => {
  const repository = mkdtempSync(
    path.join(tmpdir(), "effectory-old-download-")
  );
  let contentRequests = 0;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hello: typeof ServerHello.Type = {
            capabilities: [],
            installedRegistryRevision: "0".repeat(64),
            instanceId: "old-instance",
            limits: {},
            protocolMajor: 1,
            repositoryId: "repo",
            revision: "revision",
            serverVersion: "0.1.0",
          };
          const handlers = OldControl.toLayer({
            SystemHello: () => Effect.succeed(hello),
            SystemStatus: () =>
              Effect.succeed({
                ...hello,
                daemon: {
                  drain: null,
                  instanceId: "old-instance",
                  startedAt: new Date(0).toISOString(),
                },
                observers: 0,
                readiness: "Ready" as const,
                scheduler: {
                  activeSchedules: 0,
                  blockedSchedules: 0,
                  lastError: null,
                  pausedSchedules: 0,
                  revision: null,
                  state: "Running" as const,
                },
              }),
          });
          const http = yield* RpcServer.toHttpEffect(OldControl).pipe(
            Effect.provide(Layer.merge(handlers, RpcSerialization.layerJson))
          );
          const handler = HttpEffect.toWebHandler(http);
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                fetch: (request) => {
                  if (new URL(request.url).pathname === "/rpc/content") {
                    contentRequests += 1;
                    return new Response(null, { status: 404 });
                  }
                  return handler(request);
                },
                hostname: "127.0.0.1",
                port: 0,
              })
            ),
            (running) => Effect.promise(() => running.stop(true))
          );
          mkdirSync(path.join(repository, ".effectory"));
          writeFileSync(
            path.join(repository, ".effectory/credentials.json"),
            JSON.stringify({ repositoryId: "repo", token: "token" })
          );
          writeFileSync(
            path.join(repository, ".effectory/daemon.json"),
            JSON.stringify({
              instanceId: "old-instance",
              pid: process.pid,
              url: `http://127.0.0.1:${server.port}/rpc`,
            })
          );
          const error = yield* download(
            repository,
            "artifact",
            1,
            path.join(repository, "file.bin")
          ).pipe(Effect.flip);
          expect(error).toBeInstanceOf(OperationError);
          expect(error.message).toContain("lake.bytes.v1");
          expect(contentRequests).toBe(0);
          expect(readdirSync(repository)).toEqual([".effectory"]);
        })
      )
    );
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Hello, ServerHello, ServerStatus } from "@effectory/runtime/rpc";
import type { RunWatchFrame } from "@effectory/runtime/watch-rpc";
import { Effect, Layer, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";

import {
  makeWatchHandler,
  watchRequest,
  watchLineLimit,
  guardWatchFrame,
} from "../../platform-bun/src/watch-plane.ts";

const EventLine = Schema.Struct({
  event: Schema.Struct({ sequence: Schema.Int }),
});

const event = (
  sequence: number,
  payload: string
): typeof RunWatchFrame.Type => ({
  _tag: "Event",
  event: {
    at: "2026-11-05T00:00:00.000Z",
    payload,
    runId: "run",
    sequence,
    tag: "AttemptStarted",
  },
});
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

test("oversized event CLI preserves preceding output and prints explicit skip without generic reattach", async () => {
  const repository = mkdtempSync(
    path.join(tmpdir(), "effectory-old-download-")
  );

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hello: typeof ServerHello.Type = {
            capabilities: ["run.watch.stream.v1"],
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
          const oversized = event(3, "x".repeat(watchLineLimit));
          const expected = yield* guardWatchFrame(oversized, "0").pipe(
            Effect.flip
          );
          const watch = yield* makeWatchHandler(() =>
            Stream.fromArray([event(1, "first"), event(2, "second"), oversized])
          );
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                fetch: async (request) =>
                  new URL(request.url).pathname.startsWith("/rpc/watch")
                    ? await watch(await watchRequest(request))
                    : await handler(request),
                hostname: "127.0.0.1",
                port: 0,
              })
            ),
            (running) => Effect.promise(async () => await running.stop(true))
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
          for (const jsonl of [true, false]) {
            const result = yield* Effect.promise(async () => {
              const child = Bun.spawn(
                [
                  process.execPath,
                  path.resolve("packages/cli/src/main.ts"),
                  "run",
                  "watch",
                  "run",
                  ...(jsonl ? ["--jsonl"] : []),
                  "--repository",
                  repository,
                ],
                { stderr: "pipe", stdout: "pipe" }
              );
              const [code, stderr, stdout] = await Promise.all([
                child.exited,
                new Response(child.stderr).text(),
                new Response(child.stdout).text(),
              ]);
              return { code, stderr, stdout };
            });
            expect(result.code).toBe(5);
            expect(result.stderr).toContain(expected.message);
            expect(result.stderr).toContain("run get run");
            expect(result.stderr).not.toContain("Resume run watch");
            expect(result.stderr).toContain(
              "run watch run --jsonl --after-sequence 3"
            );
            if (jsonl) {
              expect(result.stderr).toContain("Last event written: 2.");
              expect(
                result.stdout
                  .trim()
                  .split("\n")
                  .map(
                    (line) =>
                      Schema.decodeUnknownSync(EventLine)(JSON.parse(line))
                        .event.sequence
                  )
              ).toEqual([1, 2]);
            }
          }
        })
      )
    );
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

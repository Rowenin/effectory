import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { OperationError, Run } from "@effectory/runtime/protocol";
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
const run: typeof Run.Type = {
  acceptedAt: "2026-11-05T00:00:00.000Z",
  engineId: null,
  error: null,
  input: null,
  kind: "task",
  lastSequence: 3,
  requestKey: "key",
  result: "done",
  revision: "revision",
  runId: "run",
  status: "Succeeded",
  tags: {},
  targetId: "task",
};
const OldControl = RpcGroup.make(
  Rpc.make("SystemHello", {
    error: OperationError,
    payload: Hello,
    success: ServerHello,
  }),
  Rpc.make("RunGet", {
    error: OperationError,
    payload: { runId: Schema.String },
    success: Run,
  }),
  Rpc.make("SystemStatus", {
    error: OperationError,
    payload: {},
    success: ServerStatus,
  })
);

test("human terminal replay reports an oversized tail while machine mode retains the final result", async () => {
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
            RunGet: () => Effect.succeed(run),
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
          let interrupt = false;
          const watch = yield* makeWatchHandler(() =>
            interrupt
              ? Stream.fromArray<typeof RunWatchFrame.Type>([
                  {
                    _tag: "Snapshot",
                    run: { ...run, lastSequence: 6, status: "Running" },
                  },
                  event(6, "resumed"),
                ]).pipe(Stream.concat(Stream.fromEffect(Effect.interrupt)))
              : Stream.fromArray([
                  { _tag: "Snapshot" as const, run },
                  event(1, "first"),
                  event(2, "second"),
                  oversized,
                ])
          );
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                fetch: async (request) =>
                  new URL(request.url).pathname.startsWith("/rpc/watch")
                    ? watch(await watchRequest(request))
                    : handler(request),
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
          for (const human of [true, false]) {
            const result = yield* Effect.promise(async () => {
              const child = Bun.spawn(
                [
                  process.execPath,
                  path.resolve("packages/cli/src/main.ts"),
                  "run",
                  "watch",
                  "run",
                  ...(human ? [] : ["--json"]),
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
            if (human) {
              expect(result.code).toBe(5);
              expect(result.stdout).toBe("");
              expect(result.stderr).toContain(expected.message);
              expect(result.stderr).toContain(
                "run watch run --jsonl --after-sequence 3"
              );
              expect(result.stderr).not.toContain("Resume run watch");
              expect(result.stderr).toContain("#1 ");
              expect(result.stderr).toContain("#2 ");
            } else {
              expect(result.code).toBe(0);
              expect(result.stderr).toBe("");
              expect(JSON.parse(result.stdout)).toEqual(run);
            }
          }
          interrupt = true;
          for (const flags of [[], ["--json"]]) {
            const result = yield* Effect.promise(async () => {
              const child = Bun.spawn(
                [
                  process.execPath,
                  path.resolve("packages/cli/src/main.ts"),
                  "run",
                  "watch",
                  "run",
                  "--after-sequence",
                  "5",
                  ...flags,
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
            expect(result.code).toBe(3);
            expect(result.stdout).toBe("");
            expect(result.stderr).toContain("--after-sequence 6");
            expect(result.stderr).not.toContain("--after-sequence 0");
          }
        })
      )
    );
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
}, 30_000);

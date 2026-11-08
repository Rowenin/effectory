import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Hello, ServerHello, ServerStatus } from "@effectory/runtime/rpc";
import { Effect, Layer } from "effect";
import { HttpEffect } from "effect/http";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";

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

test("old daemon refuses foreground before admission, with command-specific recovery", async () => {
  const repository = mkdtempSync(
    path.join(tmpdir(), "effectory-old-download-")
  );
  let submissions = 0;
  let statuses = 0;
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
            SystemStatus: () => {
              statuses += 1;
              return Effect.succeed({
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
              });
            },
          });
          const http = yield* RpcServer.toHttpEffect(OldControl).pipe(
            Effect.provide(Layer.merge(handlers, RpcSerialization.layerJson))
          );
          const handler = HttpEffect.toWebHandler(http);
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                fetch: async (request) =>
                  await request
                    .clone()
                    .text()
                    .then(async (body) => {
                      if (
                        body.includes('"TaskRun"') ||
                        body.includes('"WorkflowRun"') ||
                        body.includes('"RunRecover"') ||
                        body.includes('"RunRecoveryGet"') ||
                        body.includes('"ReportSearch"')
                      ) {
                        submissions += 1;
                      }
                      return await handler(request);
                    }),
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
          for (const command of [
            [
              "workflow",
              "run",
              "flow",
              "--input",
              "null",
              "--tag",
              "team=platform",
            ],
            ["run", "watch", "run", "--jsonl"],
            ["report", "search"],
            ["workflow", "run", "flow", "--background", "--report", "cost"],
            ["task", "run", "source", "--background", "--skip-reports"],
            ["run", "recover", "run"],
            [
              "run",
              "recover",
              "run",
              "--authorize",
              "token",
              "--acknowledge-reexecution",
            ],
          ]) {
            const result = yield* Effect.promise(async () => {
              const child = Bun.spawn(
                [
                  process.execPath,
                  path.resolve("packages/cli/src/main.ts"),
                  ...command,
                  "--repository",
                  repository,
                ],
                { stderr: "pipe", stdout: "pipe" }
              );
              const [code, stderr] = await Promise.all([
                child.exited,
                new Response(child.stderr).text(),
              ]);
              return { code, stderr };
            });
            expect(result.code).toBe(3);
            if (command.includes("--background")) {
              expect(result.stderr).toContain(
                "does not support report selection"
              );
            } else if (command[1] === "search") {
              expect(result.stderr).toContain("does not support report search");
            } else if (command[1] === "recover") {
              expect(result.stderr).toContain(
                "Daemon does not support recovery"
              );
            } else {
              expect(result.stderr).toContain("run.watch.stream.v1");
              expect(result.stderr).toContain(
                command[0] === "workflow" ? "--background" : "run get run"
              );
            }
          }
          expect(submissions).toBe(0);
          expect(statuses).toBe(7);
        })
      )
    );
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
}, 15_000);

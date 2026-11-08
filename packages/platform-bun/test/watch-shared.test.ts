/* oxlint-disable no-await-in-loop -- Observers are admitted sequentially and each count check depends on admission. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WatchPlane } from "@effectory/runtime/watch-rpc";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpEffect } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { HostStore, hostStoreLayer } from "../src/host-store.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { createRunWatcher } from "../src/run-watch.ts";
import { makeWatchHandler, watchRequest } from "../src/watch-plane.ts";

test("legacy JSON and framed routes share sixteen observers; stalled readers survive and shutdown releases them", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-watch-shared-")
  );
  try {
    const storage = hostStoreLayer(path.join(directory, "state.sqlite")).pipe(
      Layer.provide(ownershipLayer(path.join(directory, "owner.sqlite")))
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* HostStore;
          const run = yield* store.submit(
            {
              input: null,
              kind: "workflow",
              requestKey: "watch",
              targetId: "workflow",
            },
            "revision",
            "owner"
          );
          const watcher = createRunWatcher(store);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              expect(watcher.active).toBe(0);
            })
          );
          const framed = yield* makeWatchHandler((runId, afterSequence) =>
            watcher.watch(runId, "owner", afterSequence)
          );
          const legacy = HttpEffect.toWebHandler(
            yield* RpcServer.toHttpEffect(WatchPlane).pipe(
              Effect.provide(
                Layer.merge(
                  WatchPlane.toLayer({
                    RunWatch: ({ runId, afterSequence }) =>
                      watcher.watch(runId, "owner", afterSequence),
                  }),
                  RpcSerialization.layerJson
                )
              )
            )
          );
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                fetch: async (request, bunServer) => {
                  if (new URL(request.url).pathname === "/watch") {
                    const bounded = await watchRequest(request);
                    bunServer.timeout(request, 0);
                    return await framed(bounded);
                  }
                  return await legacy(request);
                },
                hostname: "127.0.0.1",
                idleTimeout: 1,
                port: 0,
              })
            ),
            (running) => Effect.promise(async () => await running.stop(true))
          );
          const body = JSON.stringify({
            _tag: "Request",
            headers: [],
            id: "1",
            payload: { runId: run.runId },
            tag: "RunWatch",
          });
          // Child scope owns the client signals; closing it aborts every request.
          const connections = yield* Scope.fork(yield* Effect.scope);
          const pending: Promise<unknown>[] = [];
          const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
          for (let index = 0; index < 8; index += 1) {
            const signal = yield* Effect.abortSignal.pipe(
              Scope.provide(connections)
            );
            pending.push(
              fetch(`http://127.0.0.1:${server.port}/legacy`, {
                body,
                method: "POST",
                signal,
              })
                .then(async (response) => await response.text())
                .catch(() => {})
            );
            yield* Effect.repeat(Effect.sleep("5 millis"), {
              until: () => watcher.active >= index + 1,
            }).pipe(Effect.timeout("2 seconds"));
          }
          for (let index = 0; index < 8; index += 1) {
            const signal = yield* Effect.abortSignal.pipe(
              Scope.provide(connections)
            );
            const response = yield* Effect.promise(
              async () =>
                await fetch(`http://127.0.0.1:${server.port}/watch`, {
                  body: `${body}\n`,
                  method: "POST",
                  signal,
                })
            );
            if (!response.body) {
              throw new Error("Missing body");
            }
            const reader = response.body.getReader();
            readers.push(reader);
            yield* Effect.promise(async () => await reader.read());
          }
          expect(watcher.active).toBe(16);
          for (const route of ["watch", "legacy"]) {
            const response = yield* Effect.promise(
              async () =>
                await fetch(`http://127.0.0.1:${server.port}/${route}`, {
                  body: route === "watch" ? `${body}\n` : body,
                  method: "POST",
                }).then(async (value) => await value.text())
            );
            expect(response).toContain(
              "Repository observer limit reached (16)"
            );
          }
          yield* Effect.sleep("11 seconds");
          for (const reader of readers) {
            const next = yield* Effect.promise(async () => await reader.read());
            expect(next.done).toBe(false);
          }
          expect(watcher.active).toBe(16);
          yield* Scope.close(connections, Exit.void);
          yield* Effect.promise(
            async () =>
              await Promise.all(
                readers.map(
                  async (reader) => await reader.cancel().catch(() => {})
                )
              )
          );
          yield* Effect.promise(async () => await Promise.all(pending));
          yield* Effect.repeat(Effect.sleep("5 millis"), {
            until: () => watcher.active <= 8,
          }).pipe(Effect.timeout("2 seconds"));
        })
      ).pipe(Effect.provide(storage))
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);

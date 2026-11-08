import { expect, test } from "bun:test";

import type { RunWatchFrame } from "@effectory/runtime/watch-rpc";
import { WatchPlane } from "@effectory/runtime/watch-rpc";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient } from "effect/rpc";

import {
  guardWatchFrame,
  makeWatchHandler,
  watchLineLimit,
  watchRequest,
  watchSerialization,
} from "../src/watch-plane.ts";

type Frame = typeof RunWatchFrame.Type;
const event = (sequence: number, payload = ""): Frame => ({
  _tag: "Event",
  event: {
    at: "2026-11-05T00:00:00.000Z",
    payload,
    runId: "run",
    sequence,
    tag: "AttemptStarted",
  },
});
const defaultPayload = { runId: "run" };
const body = (payload: unknown = defaultPayload) =>
  `${JSON.stringify({ _tag: "Request", headers: [], id: "request", payload, tag: "RunWatch" })}\n`;
const request = (value: string) =>
  new Request("http://127.0.0.1/rpc/watch", { body: value, method: "POST" });

test("watch requests reject invalid or oversized envelopes before admission", async () => {
  const valid = await watchRequest(request(body()));
  expect(await valid.text()).toBe(body());
  for (const value of [
    body() + body(),
    JSON.stringify([JSON.parse(body())]),
    body({ afterSequence: -1, runId: "run" }),
    body({ extra: true, runId: "run" }),
    body().replace("RunWatch", "RunGet"),
    " ".repeat(16_385),
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Each malformed request is independently checked.
    await expect(watchRequest(request(value))).rejects.toThrow();
  }
  const invalidUtf8 = new Request("http://127.0.0.1/rpc/watch", {
    body: new Uint8Array([255]),
    method: "POST",
  });
  await expect(watchRequest(invalidUtf8)).rejects.toThrow();
});

test("guard measures actual envelope in UTF-16 units at exact boundary", async () => {
  const empty = event(1);
  const overhead = JSON.stringify({
    _tag: "Chunk",
    requestId: "request",
    values: [empty],
  }).length;
  const exact = event(1, "\uFFFF".repeat(watchLineLimit - overhead));
  expect(await Effect.runPromise(guardWatchFrame(exact, "request"))).toEqual(
    exact
  );
  expect(Buffer.byteLength(JSON.stringify(exact))).toBeGreaterThan(
    watchLineLimit
  );
  expect(Buffer.byteLength(`${JSON.stringify(exact)}\n`)).toBeLessThanOrEqual(
    6_291_457
  );
  const tooLarge = event(1, "x".repeat(watchLineLimit - overhead + 1));
  const result = await Effect.runPromiseExit(
    guardWatchFrame(tooLarge, "request")
  );
  expect(result._tag).toBe("Failure");
});

test("real RPC preserves preceding batch frames before typed oversized failure", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const handler = yield* makeWatchHandler(() =>
          Stream.fromArray([
            event(1, "first"),
            event(2, "second"),
            event(3, "x".repeat(watchLineLimit)),
          ])
        );
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              fetch: async (incoming) =>
                await handler(await watchRequest(incoming)),
              hostname: "127.0.0.1",
              port: 0,
            })
          ),
          (running) => Effect.promise(async () => await running.stop(true))
        );
        const url = `http://127.0.0.1:${server.port}/rpc/watch`;
        const protocol = RpcClient.layerProtocolHttp({ url }).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(watchSerialization)
        );
        const client = yield* RpcClient.make(WatchPlane).pipe(
          Effect.provide(protocol)
        );
        const seen: Frame[] = [];
        const failure = yield* client.RunWatch({ runId: "run" }).pipe(
          Stream.runForEach((frame) =>
            Effect.sync(() => {
              seen.push(frame);
            })
          ),
          Effect.flip
        );
        expect(seen).toEqual([event(1, "first"), event(2, "second")]);
        expect(failure).toMatchObject({ code: "LimitExceeded" });
        expect(String(failure)).toContain("--jsonl --after-sequence 3");
        const raw = yield* Effect.promise(
          async () =>
            await fetch(url, { body: body(), method: "POST" }).then(
              async (response) => await response.text()
            )
        );
        for (const line of raw.trim().split("\n")) {
          expect(line.length).toBeLessThanOrEqual(watchLineLimit);
        }
      })
    )
  );
});

test("watch bounds defect lines and typed errors", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const handler = yield* makeWatchHandler(() =>
          Stream.die("x".repeat(watchLineLimit * 2))
        );
        const response = yield* Effect.promise(
          async () =>
            await handler(request(body())).then(
              async (value) => await value.text()
            )
        );
        expect(response.length).toBeLessThan(4096);
        expect(response).toContain("Unavailable");
        expect(response).toContain("Watch handler failed");
      })
    )
  );
});

function readerFor(response: Response) {
  if (!response.body) {
    throw new Error("Missing response body");
  }
  return response.body.getReader();
}

test("sixteen active watch producers reject the seventeenth with typed error and release on disconnect", async () => {
  let opened = 0;
  let closed = 0;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            // Simulates the enclosing lake Layer finalizer registered before RPC construction.
            expect(closed).toBe(opened);
          })
        );
        const handler = yield* makeWatchHandler(() =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  opened += 1;
                }),
                () =>
                  Effect.sync(() => {
                    closed += 1;
                  })
              );
              return Stream.succeed<Frame>(event(1)).pipe(
                Stream.concat(Stream.never)
              );
            })
          )
        );
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              fetch: async (incoming) => await handler(incoming),
              hostname: "127.0.0.1",
              idleTimeout: 0,
              port: 0,
            })
          ),
          (running) => Effect.promise(async () => await running.stop(true))
        );
        const url = `http://127.0.0.1:${server.port}/rpc/watch`;
        // Child scope owns the client signals; closing it aborts these requests.
        const connections = yield* Scope.fork(yield* Effect.scope);
        for (let index = 0; index < 16; index += 1) {
          const signal = yield* Effect.abortSignal.pipe(
            Scope.provide(connections)
          );
          const response = yield* Effect.promise(
            async () =>
              await fetch(url, {
                body: body(),
                method: "POST",
                signal,
              })
          );
          expect(response.status).toBe(200);
          const reader = readerFor(response);
          yield* Effect.promise(async () => await reader.read());
        }
        expect(opened).toBe(16);
        const refused = yield* Effect.promise(
          async () =>
            await fetch(url, { body: body(), method: "POST" }).then(
              async (response) => await response.text()
            )
        );
        expect(refused).toContain("LimitExceeded");
        expect(refused).toContain("16 watch connections active");
        yield* Scope.close(connections, Exit.void);
        yield* Effect.repeat(Effect.yieldNow, {
          until: () => closed === 16,
        }).pipe(Effect.timeout("2 seconds"));
        expect(closed).toBe(16);
        const response = yield* Effect.promise(
          async () =>
            await fetch(url, {
              body: body(),
              method: "POST",
            })
        );
        yield* Effect.promise(async () => await readerFor(response).read());
        expect(opened).toBe(17);
        // Keep this producer active: server shutdown must close it before the outer lake scope.
      })
    )
  );
  expect(closed).toBe(17);
});

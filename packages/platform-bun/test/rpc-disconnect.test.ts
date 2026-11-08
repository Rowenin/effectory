import { expect, test } from "bun:test";

import { Deferred, Effect, Layer, Schema, Stream } from "effect";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";

import { contentRequest, makeContentHandler } from "../src/content-plane.ts";
import { rpcWebHandler } from "../src/rpc-web-handler.ts";
import { makeWatchHandler, watchRequest } from "../src/watch-plane.ts";

const Control = RpcGroup.make(
  Rpc.make("Pending", { payload: Schema.Struct({}), success: Schema.String })
);

const unchangedRequest = (request: Request) => Promise.resolve(request);

test.each(["control", "content", "watch"] as const)(
  "%s disconnect before the first response releases work and permits",
  async (kind) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let entered = yield* Deferred.make<boolean>();
          let closed = yield* Deferred.make<boolean>();
          let active = 0;
          let releases = 0;
          const pending = Effect.suspend(() => {
            const completion = closed;
            return Effect.acquireRelease(
              Effect.sync(() => {
                active += 1;
              }),
              () =>
                Effect.sync(() => {
                  active -= 1;
                  releases += 1;
                }).pipe(Effect.andThen(Deferred.succeed(completion, true)))
            ).pipe(
              Effect.andThen(Deferred.succeed(entered, true)),
              Effect.andThen(Effect.never)
            );
          });
          const control = yield* RpcServer.toHttpEffect(Control).pipe(
            Effect.provide(
              Layer.merge(
                Control.toLayer({ Pending: () => pending.pipe(Effect.scoped) }),
                RpcSerialization.layerJson
              )
            )
          );
          let handler = rpcWebHandler(control);
          let prepare = unchangedRequest;
          let payload: object = {};
          let tag = "Pending";
          if (kind === "content") {
            handler = yield* makeContentHandler(() => Stream.unwrap(pending));
            prepare = contentRequest;
            payload = { artifactId: "artifact", version: 1 };
            tag = "LakeDownload";
          } else if (kind === "watch") {
            handler = yield* makeWatchHandler(() => Stream.unwrap(pending));
            prepare = watchRequest;
            payload = { runId: "run" };
            tag = "RunWatch";
          }
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                fetch: async (request) => handler(await prepare(request)),
                hostname: "127.0.0.1",
                idleTimeout: 0,
                port: 0,
              })
            ),
            (running) => Effect.promise(() => running.stop(true))
          );
          const iterations = kind === "watch" ? 17 : 5;
          for (let index = 0; index < iterations; index += 1) {
            entered = yield* Deferred.make<boolean>();
            closed = yield* Deferred.make<boolean>();
            const abort = new AbortController();
            const body = JSON.stringify({
              _tag: "Request",
              headers: [],
              id: "1",
              payload,
              tag,
            });
            const request = fetch(`http://127.0.0.1:${server.port}`, {
              body: `${body}\n`,
              method: "POST",
              signal: abort.signal,
            }).then(
              () => "response",
              () => "aborted"
            );
            yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"));
            expect(active).toBe(1);
            abort.abort();
            expect(yield* Effect.promise(() => request)).toBe("aborted");
            // Server/RPC scopes remain open. Disconnect alone must close work.
            yield* Deferred.await(closed).pipe(Effect.timeout("2 seconds"));
            expect(active).toBe(0);
            expect(releases).toBe(index + 1);
          }
        })
      )
    );
  },
  15_000
);

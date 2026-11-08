import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { ContentPlane } from "@effectory/runtime/content-rpc";
import type { DownloadFrame } from "@effectory/runtime/lake-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient } from "effect/rpc";

import {
  contentRequest,
  contentSerialization,
  makeContentHandler,
} from "../src/content-plane.ts";

const defaultPayload = { artifactId: "artifact", version: 1 };
function readerFor(response: Response) {
  if (!response.body) {
    throw new Error("Expected streaming body");
  }
  return response.body.getReader();
}
const requestBody = (payload: unknown = defaultPayload) =>
  `${JSON.stringify({
    _tag: "Request",
    headers: [],
    id: "1",
    payload,
    tag: "LakeDownload",
  })}\n`;
const request = (body: string) =>
  new Request("http://127.0.0.1/rpc/content", { body, method: "POST" });
const bytes = new Uint8Array(65_536).fill(42);
const metadata: Extract<DownloadFrame, { _tag: "Metadata" }>["metadata"] = {
  artifactId: "artifact",
  attemptId: "attempt",
  bytes: bytes.length,
  committedAt: new Date(0).toISOString(),
  contentType: "application/octet-stream",
  digest: createHash("sha256").update(bytes).digest("hex"),
  invocationPath: "task",
  kind: "bytes",
  output: "file",
  revision: "revision",
  runId: "run",
  schemaId: "binary/file",
  schemaVersion: 1,
  sequence: 1,
  tags: {},
  taskId: "task",
  version: 1,
};

test("content request accepts exactly one bounded validated RPC envelope", async () => {
  const valid = await contentRequest(request(requestBody()));
  expect(await valid.text()).toBe(requestBody());
  for (const body of [
    requestBody() + requestBody(),
    JSON.stringify([JSON.parse(requestBody())]),
    requestBody({ artifactId: "artifact", version: 0 }),
    requestBody({ artifactId: "artifact", extra: true, version: 1 }),
    requestBody().replace("LakeDownload", "LakeGet"),
    requestBody().replace('"headers":[]', '"headers":[],"isNotification":true'),
    " ".repeat(16_385),
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Each malformed request is independently asserted.
    await expect(contentRequest(request(body))).rejects.toThrow();
  }
});

test("content RPC emits individual bounded frames and round-trips Uint8Array", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const handler = yield* makeContentHandler(() =>
          Stream.fromArray<DownloadFrame>([
            {
              _tag: "Metadata",
              metadata: { ...metadata, bytes: bytes.length * 3 },
            },
            { _tag: "Bytes", bytes },
            { _tag: "Bytes", bytes },
            { _tag: "Bytes", bytes },
          ])
        );
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              fetch: async (incoming) =>
                await handler(await contentRequest(incoming)),
              hostname: "127.0.0.1",
              port: 0,
            })
          ),
          (running) => Effect.promise(async () => await running.stop(true))
        );
        const url = `http://127.0.0.1:${server.port}/rpc/content`;
        const raw = yield* Effect.promise(
          async () =>
            await fetch(url, { body: requestBody(), method: "POST" }).then(
              async (response) => await response.text()
            )
        );
        for (const line of raw.trim().split("\n")) {
          expect(Buffer.byteLength(line)).toBeLessThan(131_072);
        }
        const protocol = RpcClient.layerProtocolHttp({ url }).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(contentSerialization)
        );
        const client = yield* RpcClient.make(ContentPlane).pipe(
          Effect.provide(protocol)
        );
        const frames = yield* client
          .LakeDownload({ artifactId: "artifact", version: 1 })
          .pipe(Stream.runCollect);
        expect(frames).toHaveLength(4);
        expect(frames[0]?._tag).toBe("Metadata");
        for (const frame of frames.slice(1)) {
          expect(frame._tag).toBe("Bytes");
          if (frame._tag === "Bytes") {
            expect(frame.bytes).toEqual(bytes);
          }
        }
      })
    )
  );
});

test("four active producers reject the fifth with typed error and release on disconnect", async () => {
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
        const handler = yield* makeContentHandler(() =>
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
              return Stream.succeed<DownloadFrame>({
                _tag: "Metadata",
                metadata,
              }).pipe(Stream.concat(Stream.never));
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
        const url = `http://127.0.0.1:${server.port}/rpc/content`;
        // Child scope owns the client signals; closing it aborts these requests.
        const connections = yield* Scope.fork(yield* Effect.scope);
        for (let index = 0; index < 4; index += 1) {
          const signal = yield* Effect.abortSignal.pipe(
            Scope.provide(connections)
          );
          const response = yield* Effect.promise(
            async () =>
              await fetch(url, {
                body: requestBody(),
                method: "POST",
                signal,
              })
          );
          expect(response.status).toBe(200);
          const reader = readerFor(response);
          yield* Effect.promise(async () => await reader.read());
        }
        expect(opened).toBe(4);
        const refused = yield* Effect.promise(
          async () =>
            await fetch(url, { body: requestBody(), method: "POST" }).then(
              async (response) => await response.text()
            )
        );
        expect(refused).toContain("LimitExceeded");
        expect(refused).toContain("4 downloads active");
        yield* Scope.close(connections, Exit.void);
        yield* Effect.repeat(Effect.yieldNow, {
          until: () => closed === 4,
        }).pipe(Effect.timeout("2 seconds"));
        expect(closed).toBe(4);
        const response = yield* Effect.promise(
          async () =>
            await fetch(url, {
              body: requestBody(),
              method: "POST",
            })
        );
        yield* Effect.promise(async () => await readerFor(response).read());
        expect(opened).toBe(5);
        // Keep this producer active: server shutdown must close it before the outer lake scope.
      })
    )
  );
  expect(closed).toBe(5);
});

test("content RPC preserves typed lake errors", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const handler = yield* makeContentHandler(() =>
          Stream.fail(
            new OperationError({ code: "NotFound", message: "reclaimed" })
          )
        );
        const response = yield* Effect.promise(
          async () =>
            await handler(request(requestBody())).then(
              async (result) => await result.text()
            )
        );
        expect(response).toContain("NotFound");
        expect(response).toContain("reclaimed");
      })
    )
  );
});

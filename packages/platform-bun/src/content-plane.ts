import { ContentPlane } from "@effectory/runtime/content-rpc";
import type { DownloadFrame } from "@effectory/runtime/lake-protocol";
import { DownloadRequest } from "@effectory/runtime/lake-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import {
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { Lake } from "./lake.ts";
import { rpcWebHandler } from "./rpc-web-handler.ts";

const Envelope = Schema.TaggedStruct("Request", {
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  id: Schema.Union([Schema.String, Schema.Finite]),
  payload: DownloadRequest,
  sampled: Schema.optionalKey(Schema.Boolean),
  spanId: Schema.optionalKey(Schema.String),
  tag: Schema.Literal("LakeDownload"),
  traceId: Schema.optionalKey(Schema.String),
});
const RequestPermit = Context.Service<boolean>(
  "effectory/ContentRequestPermit"
);
export const contentSerialization = RpcSerialization.layerNdjsonWith({
  maxBufferSize: 131_072,
});

/** Read the bounded body before the RPC adapter's unbounded request.text(). */
export async function contentRequest(request: Request): Promise<Request> {
  const reader = request.body?.getReader();
  if (!reader) {
    throw new Error("Missing content request body");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- Each bounded body read depends on its predecessor.
      const next = await reader.read();
      if (next.done) {
        break;
      }
      length += next.value.byteLength;
      if (length > 16_384) {
        throw new Error("Content request exceeds 16 KiB");
      }
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = text.trim().split("\n");
  if (lines.length !== 1) {
    throw new Error("Expected one content RPC request");
  }
  Schema.decodeUnknownSync(Envelope)(JSON.parse(lines[0] ?? ""), {
    onExcessProperty: "error",
  });
  return new Request(request.url, {
    body: text,
    headers: request.headers,
    method: "POST",
    signal: request.signal,
  });
}

/** The HTTP scope, rather than handler completion, owns producer admission. */
export const makeContentHandler = (
  download: (
    artifactId: string,
    version: number
  ) => Stream.Stream<DownloadFrame, OperationError>
) =>
  Effect.gen(function* () {
    const permits = yield* Semaphore.make(4);
    const handlers = ContentPlane.toLayer({
      LakeDownload: ({ artifactId, version }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const permit = yield* Effect.serviceOption(RequestPermit);
            if (Option.isNone(permit)) {
              return yield* new OperationError({
                code: "Unavailable",
                message: "Content request scope is unavailable",
              });
            }
            if (!permit.value) {
              return yield* new OperationError({
                code: "LimitExceeded",
                message: "4 downloads active; retry later",
              });
            }
            return download(artifactId, version).pipe(Stream.rechunk(1));
          })
        ),
    });
    const http = yield* RpcServer.toHttpEffect(ContentPlane, {
      disableFatalDefects: true,
      streamBufferSize: 4,
    }).pipe(Effect.provide(Layer.merge(handlers, contentSerialization)));
    const admitted = Effect.gen(function* () {
      const accepted = yield* Effect.acquireRelease(
        permits.takeIfAvailable(1),
        (taken) => (taken ? Effect.asVoid(permits.release(1)) : Effect.void)
      );
      return yield* http.pipe(Effect.provideService(RequestPermit, accepted));
    });
    return rpcWebHandler(admitted);
  });

export const contentHandler = Effect.flatMap(Lake, (lake) =>
  makeContentHandler(lake.download)
);

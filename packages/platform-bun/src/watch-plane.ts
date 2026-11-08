import { OperationError } from "@effectory/runtime/protocol";
import {
  WatchPlane,
  RunWatchFrame,
  RunWatchRequest,
} from "@effectory/runtime/watch-rpc";
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

import { rpcWebHandler } from "./rpc-web-handler.ts";
import { RunWatcher } from "./run-watch.ts";

export const watchLineLimit = 2_097_152;

const Envelope = Schema.Struct({
  _tag: Schema.Literal("Request"),
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  id: Schema.Union([Schema.String, Schema.Finite]),
  payload: RunWatchRequest,
  sampled: Schema.optionalKey(Schema.Boolean),
  spanId: Schema.optionalKey(Schema.String),
  tag: Schema.Literal("RunWatch"),
  traceId: Schema.optionalKey(Schema.String),
});
const RequestPermit = Context.Service<boolean>("effectory/WatchRequestPermit");
export const watchSerialization = RpcSerialization.layerNdjsonWith({
  maxBufferSize: watchLineLimit,
});

/** Read the bounded body before the RPC adapter's unbounded request.text(). */
export async function watchRequest(request: Request): Promise<Request> {
  const reader = request.body?.getReader();
  if (!reader) {
    throw new Error("Missing watch request body");
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
        throw new Error("Watch request exceeds 16 KiB");
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
    throw new Error("Expected one watch RPC request");
  }
  Schema.decodeUnknownSync(Envelope)(JSON.parse(lines[0] ?? ""), {
    onExcessProperty: "error",
  });
  return new Request(request.url, {
    body: `${text.trim()}\n`,
    headers: request.headers,
    method: "POST",
    signal: request.signal,
  });
}

const encodeFrame = Schema.encodeUnknownSync(Schema.toCodecJson(RunWatchFrame));
export const guardWatchFrame = (
  frame: typeof RunWatchFrame.Type,
  requestId: string
) =>
  Effect.suspend(() => {
    const { length } = JSON.stringify({
      _tag: "Chunk",
      requestId,
      values: [encodeFrame(frame)],
    });
    if (length <= watchLineLimit) {
      return Effect.succeed(frame);
    }
    const message =
      frame._tag === "Event"
        ? `Event ${frame.event.sequence} of run ${frame.event.runId} exceeds the live watch limit and remains stored. It also exceeds the run events page limit; this release has no CLI or RPC reader for it. Inspect run state with run get ${frame.event.runId}. To intentionally skip it and continue, use run watch ${frame.event.runId} --jsonl --after-sequence ${frame.event.sequence}.`
        : `${frame._tag} exceeds the live watch limit`;
    return Effect.fail(new OperationError({ code: "LimitExceeded", message }));
  });

/** The HTTP scope, rather than handler completion, owns producer admission. */
export const makeWatchHandler = (
  watch: (
    runId: string,
    afterSequence?: number
  ) => Stream.Stream<typeof RunWatchFrame.Type, OperationError>
) =>
  Effect.gen(function* () {
    const permits = yield* Semaphore.make(16);
    const handlers = WatchPlane.toLayer({
      RunWatch: ({ runId, afterSequence }, options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const permit = yield* Effect.serviceOption(RequestPermit);
            if (Option.isNone(permit)) {
              return yield* new OperationError({
                code: "Unavailable",
                message: "Watch request scope is unavailable",
              });
            }
            if (!permit.value) {
              return yield* new OperationError({
                code: "LimitExceeded",
                message: "16 watch connections active",
              });
            }
            return watch(runId, afterSequence).pipe(
              Stream.rechunk(1),
              Stream.mapEffect((frame) =>
                guardWatchFrame(frame, String(options.requestId))
              ),
              Stream.mapError(
                // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This is an Effect Stream error mapper, not a Promise callback.
                (error) =>
                  new OperationError({
                    code: error.code,
                    message: error.message.slice(0, 4096),
                  })
              ),
              Stream.catchDefect(() =>
                Stream.fail(
                  new OperationError({
                    code: "Unavailable",
                    message: "Watch handler failed",
                  })
                )
              ),
              Stream.rechunk(1)
            );
          })
        ),
    });
    const http = yield* RpcServer.toHttpEffect(WatchPlane, {
      disableFatalDefects: true,
      streamBufferSize: 4,
    }).pipe(Effect.provide(Layer.merge(handlers, watchSerialization)));
    const admitted = Effect.gen(function* () {
      const accepted = yield* Effect.acquireRelease(
        permits.takeIfAvailable(1),
        (taken) => (taken ? Effect.asVoid(permits.release(1)) : Effect.void)
      );
      return yield* http.pipe(Effect.provideService(RequestPermit, accepted));
    });
    return rpcWebHandler(admitted);
  });

export const watchHandler = Effect.flatMap(RunWatcher, (watcher) =>
  makeWatchHandler((runId, afterSequence) =>
    watcher.watch(runId, "owner", afterSequence)
  )
);

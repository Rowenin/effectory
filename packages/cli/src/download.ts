import { createHash } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { connectContent } from "@effectory/platform-bun/client";
import {
  DownloadMetadata,
  DownloadRequest,
} from "@effectory/runtime/lake-protocol";
import type { DownloadFrame } from "@effectory/runtime/lake-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema, Stream } from "effect";

function fileError(cause: unknown): OperationError {
  const code =
    typeof cause === "object" && cause !== null
      ? Reflect.get(cause, "code")
      : undefined;
  let errorCode: OperationError["code"] = "Unavailable";
  if (code === "EEXIST") {
    errorCode = "Conflict";
  }
  if (["ENOSPC", "EDQUOT"].includes(String(code))) {
    errorCode = "StorageFull";
  }
  return new OperationError({
    code: errorCode,
    message:
      code === "EEXIST"
        ? "Download destination exists; choose a new output path"
        : `Download filesystem operation failed (${String(code ?? cause)}); hard-link support is required`,
  });
}
const invalid = (message: string) =>
  new OperationError({ code: "ContentUnavailable", message });

/** Bytes remain provisional until transport completion and independent digest validation. */
export function downloadToFile<E, R>(
  source: Stream.Stream<DownloadFrame, E, R>,
  request: typeof DownloadRequest.Type,
  output: string
) {
  return Effect.scoped(
    Effect.gen(function* () {
      if (output === "-" || output.length === 0) {
        return yield* new OperationError({
          code: "InvalidInput",
          message:
            "Download requires an output file path; stdout is unsupported",
        });
      }
      const destination = path.resolve(output);
      const temporary = path.join(
        path.dirname(destination),
        `.effectory-download-${crypto.randomUUID()}`
      );
      const file = yield* Effect.acquireRelease(
        Effect.tryPromise({
          catch: fileError,
          try: () => open(temporary, "wx", 0o600),
        }),
        (handle) =>
          Effect.tryPromise({
            catch: fileError,
            try: async () => {
              let closeError: unknown;
              try {
                await handle.close();
              } catch (error) {
                closeError = error;
              }
              try {
                unlinkSync(temporary);
              } catch (error) {
                if (
                  typeof error !== "object" ||
                  error === null ||
                  Reflect.get(error, "code") !== "ENOENT"
                ) {
                  throw error;
                }
              }
              if (closeError !== undefined) {
                throw closeError;
              }
            },
          }).pipe(Effect.catch((error) => Effect.logWarning(error.message)))
      );
      let metadata: typeof DownloadMetadata.Type | undefined;
      let length = 0;
      const digest = createHash("sha256");
      yield* source.pipe(
        Stream.runForEach((frame) =>
          Effect.gen(function* () {
            if (frame._tag === "Metadata") {
              if (metadata !== undefined) {
                return yield* invalid("Download repeated its metadata frame");
              }
              metadata = yield* Schema.decodeUnknownEffect(DownloadMetadata)(
                frame.metadata
              ).pipe(
                Effect.mapError(() => invalid("Invalid download metadata"))
              );
              if (
                metadata.artifactId !== request.artifactId ||
                metadata.version !== request.version ||
                metadata.bytes < 0 ||
                metadata.bytes > 16_777_216 ||
                !/^[a-f0-9]{64}$/u.test(metadata.digest)
              ) {
                return yield* invalid(
                  "Download metadata does not match the requested version or byte limit"
                );
              }
              return;
            }
            if (!metadata) {
              return yield* invalid("Download bytes arrived before metadata");
            }
            length += frame.bytes.byteLength;
            if (length > metadata.bytes || frame.bytes.byteLength > 65_536) {
              return yield* invalid(
                "Download exceeds its announced length or frame limit"
              );
            }
            digest.update(frame.bytes);
            yield* Effect.tryPromise({
              catch: fileError,
              try: async () => {
                let offset = 0;
                while (offset < frame.bytes.byteLength) {
                  // oxlint-disable-next-line no-await-in-loop -- Partial writes advance the offset sequentially.
                  const written = await file.write(
                    frame.bytes,
                    offset,
                    frame.bytes.byteLength - offset
                  );
                  if (written.bytesWritten === 0) {
                    throw new Error("Download file write made no progress");
                  }
                  offset += written.bytesWritten;
                }
              },
            }).pipe(Effect.uninterruptible);
          })
        )
      );
      if (
        !metadata ||
        length !== metadata.bytes ||
        digest.digest("hex") !== metadata.digest
      ) {
        return yield* invalid(
          "Download did not complete with its announced length and digest"
        );
      }
      yield* Effect.tryPromise({
        catch: fileError,
        try: () => file.sync(),
      }).pipe(Effect.uninterruptible);
      let installed = false;
      yield* Effect.try({
        catch: (error) => {
          const failure = fileError(error);
          return installed
            ? new OperationError({
                code: failure.code,
                message: `Download was installed at ${destination}, but final cleanup or directory sync failed: ${failure.message}`,
              })
            : failure;
        },
        try: () => {
          linkSync(temporary, destination);
          installed = true;
          unlinkSync(temporary);
          const directory = openSync(path.dirname(destination), "r");
          try {
            fsyncSync(directory);
          } finally {
            closeSync(directory);
          }
        },
      });
      return { bytes: length, metadata, path: destination };
    })
  );
}

export const download = (
  repository: string,
  artifactId: string,
  version: number,
  output: string
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknownEffect(DownloadRequest)({
        artifactId,
        version,
      }).pipe(
        Effect.mapError(
          () =>
            new OperationError({
              code: "InvalidInput",
              message: "Download requires an artifact id and positive version",
            })
        )
      );
      // Both the handshake and capability check precede any temporary-file creation.
      const client = yield* connectContent(repository);
      return yield* downloadToFile(
        client.LakeDownload(request),
        request,
        output
      );
    })
  );

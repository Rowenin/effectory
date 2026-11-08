/* oxlint-disable no-bitwise -- Native POSIX open flags. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import path from "node:path";

import type {
  DownloadFrame,
  Record as ArtifactRecord,
} from "@effectory/runtime/lake-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Stream } from "effect";

import {
  blockBytes,
  binaryLimit,
  fileEffect,
  readBlock,
} from "./lake-binary.ts";

/** Metadata check and open are one non-yielding operation shared with reclamation. */
export function binaryDownload<E = never>(
  directory: string,
  lookup: () => ArtifactRecord,
  mapOpenError?: (cause: unknown) => E
): Stream.Stream<DownloadFrame, OperationError | E> {
  // Task readers preserve native open/liveness failures before the CLI's
  // generic storage adapter erases their classification.
  const openEffect = <A>(body: () => A): Effect.Effect<A, OperationError | E> =>
    mapOpenError
      ? Effect.try({ catch: mapOpenError, try: body })
      : fileEffect(body);
  return Stream.unwrap(
    Effect.gen(function* () {
      const opened = yield* Effect.acquireRelease(
        openEffect(() => {
          const record = lookup();
          if (record.kind !== "bytes") {
            throw new OperationError({
              code: "InvalidInput",
              message:
                "JSON artifacts use effectory lake get <artifactId> --version <n>",
            });
          }
          if (
            !/^[a-f0-9]{64}$/u.test(record.digest) ||
            record.contentType === undefined ||
            record.contentType === "" ||
            record.bytes < 0 ||
            record.bytes > binaryLimit
          ) {
            throw new OperationError({
              code: "ContentUnavailable",
              message: "Invalid binary artifact metadata",
            });
          }
          const fd = openSync(
            path.join(directory, record.digest),
            constants.O_RDONLY | constants.O_NOFOLLOW
          );
          try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size !== record.bytes) {
              throw new OperationError({
                code: "ContentUnavailable",
                message:
                  "Binary artifact length or file type differs from metadata",
              });
            }
            return {
              fd,
              record: {
                ...record,
                contentType: record.contentType,
                kind: "bytes" as const,
              },
            };
          } catch (error) {
            closeSync(fd);
            throw error;
          }
        }),
        ({ fd }) => fileEffect(() => closeSync(fd)).pipe(Effect.orDie)
      );
      const descriptor = opened.fd;
      const metadata = opened.record;
      const hash = createHash("sha256");
      const bytes = Stream.unfold(0, (position) =>
        Effect.gen(function* () {
          const buffer = new Uint8Array(blockBytes);
          const size = yield* readBlock(descriptor, buffer, position);
          if (size === 0) {
            if (
              position !== metadata.bytes ||
              hash.digest("hex") !== metadata.digest
            ) {
              return yield* new OperationError({
                code: "ContentUnavailable",
                message: "Binary artifact digest or length does not match",
              });
            }
            return;
          }
          if (position + size > metadata.bytes) {
            return yield* new OperationError({
              code: "ContentUnavailable",
              message: "Binary artifact length changed",
            });
          }
          const chunk = buffer.subarray(0, size);
          hash.update(chunk);
          return [
            { _tag: "Bytes" as const, bytes: chunk },
            position + size,
          ] as const;
        })
      );
      return Stream.concat(
        Stream.succeed({ _tag: "Metadata" as const, metadata }),
        bytes
      ).pipe(Stream.rechunk(1));
    })
  );
}

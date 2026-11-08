import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect } from "effect";

import { storageError } from "./storage-error.ts";

const uncertain = () =>
  new OperationError({
    code: "RevisionUnavailable",
    message:
      "Upgrade inspection cannot certify the SQLite WAL. Preserve the database and sidecars for compatible recovery or restore a verified copy; do not discard the WAL.",
  });

function readExactly(fd: number, buffer: Buffer, position: number) {
  let offset = 0;
  while (offset < buffer.length) {
    const bytes = readSync(
      fd,
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );
    if (bytes === 0) {
      throw uncertain();
    }
    offset += bytes;
  }
}

// SQLite fileformat.html §4.2. Values stored in the header are always big-endian.
function checksum(
  bytes: Buffer,
  littleEndian: boolean,
  seed: readonly [number, number]
): [number, number] {
  let [first, second] = seed;
  for (let offset = 0; offset < bytes.length; offset += 8) {
    first =
      (first +
        (littleEndian
          ? bytes.readUInt32LE(offset)
          : bytes.readUInt32BE(offset)) +
        second) %
      4_294_967_296;
    second =
      (second +
        (littleEndian
          ? bytes.readUInt32LE(offset + 4)
          : bytes.readUInt32BE(offset + 4)) +
        first) %
      4_294_967_296;
  }
  return [first, second];
}

/**
 * Conservative upgrade admission, not SQLite recovery. Do not let SQLite quietly
 * drop an invalid tail and then mistake integrity_check=ok for complete history.
 * Reused tails, incomplete writes and a header without commits remain uncertain.
 * A checksum-valid WAL is evidence of these bytes only, not of missing history.
 */
export function validateUpgradeWal(filename: string, maximumBytes: number) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fd = yield* Effect.acquireRelease(
        Effect.try({
          catch: (cause) => storageError(cause, "Cannot read upgrade WAL"),
          try: () => openSync(filename, "r"),
        }),
        (descriptor) => Effect.sync(() => closeSync(descriptor))
      );
      const state = yield* Effect.try({
        catch: (cause) => storageError(cause, "Cannot validate upgrade WAL"),
        try: () => {
          const { size } = fstatSync(fd);
          if (size > maximumBytes) {
            throw new OperationError({
              code: "LimitExceeded",
              message: "Upgrade WAL exceeds the inspection byte budget",
            });
          }
          if (size === 0) {
            return null;
          }
          if (size < 32) {
            throw uncertain();
          }
          const header = Buffer.alloc(32);
          readExactly(fd, header, 0);
          const magic = header.readUInt32BE(0);
          const pageSize = header.readUInt32BE(8);
          if (
            (magic !== 0x37_7f_06_82 && magic !== 0x37_7f_06_83) ||
            header.readUInt32BE(4) !== 3_007_000 ||
            pageSize < 512 ||
            pageSize > 65_536 ||
            !Number.isInteger(Math.log2(pageSize))
          ) {
            throw uncertain();
          }
          const sum = checksum(
            header.subarray(0, 24),
            magic === 0x37_7f_06_82,
            [0, 0]
          );
          if (
            sum[0] !== header.readUInt32BE(24) ||
            sum[1] !== header.readUInt32BE(28)
          ) {
            throw uncertain();
          }
          const frameSize = pageSize + 24;
          if (size === 32 || (size - 32) % frameSize !== 0) {
            throw uncertain();
          }
          return {
            buffer: Buffer.alloc(frameSize),
            frames: (size - 32) / frameSize,
            header,
            littleEndian: magic === 0x37_7f_06_82,
            sum,
          };
        },
      });
      if (state === null) {
        return { frames: 0, lastCommitPages: 0, pageSize: 0 };
      }
      let lastCommitPages = 0;
      const readFrame = (index: number) =>
        Effect.try({
          catch: (cause) =>
            storageError(cause, "Cannot validate upgrade WAL frame"),
          try: () => {
            readExactly(fd, state.buffer, 32 + index * state.buffer.length);
            const frame = state.buffer;
            if (
              frame.readUInt32BE(0) === 0 ||
              !frame.subarray(8, 16).equals(state.header.subarray(16, 24))
            ) {
              throw uncertain();
            }
            state.sum = checksum(
              frame.subarray(0, 8),
              state.littleEndian,
              state.sum
            );
            state.sum = checksum(
              frame.subarray(24),
              state.littleEndian,
              state.sum
            );
            if (
              state.sum[0] !== frame.readUInt32BE(16) ||
              state.sum[1] !== frame.readUInt32BE(20)
            ) {
              throw uncertain();
            }
            lastCommitPages = frame.readUInt32BE(4);
          },
        });
      for (let index = 0; index < state.frames; index += 1) {
        yield* readFrame(index);
        if (index % 128 === 127) {
          yield* Effect.yieldNow;
        }
      }
      if (lastCommitPages === 0) {
        return yield* uncertain();
      }
      return {
        frames: state.frames,
        lastCommitPages,
        pageSize: state.buffer.length - 24,
      };
    })
  );
}

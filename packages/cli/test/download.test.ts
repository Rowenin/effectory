import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DownloadFrame } from "@effectory/runtime/lake-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Stream } from "effect";

import { downloadToFile } from "../src/download.ts";

const payload = new Uint8Array([0, 255, 128, 10]);
const metadata: Extract<DownloadFrame, { _tag: "Metadata" }>["metadata"] = {
  artifactId: "artifact",
  attemptId: "attempt",
  bytes: payload.length,
  committedAt: new Date(0).toISOString(),
  contentType: "application/octet-stream",
  digest: createHash("sha256").update(payload).digest("hex"),
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
const request = { artifactId: "artifact", version: 1 };
const frames = (): Stream.Stream<DownloadFrame> =>
  Stream.make(
    { _tag: "Metadata", metadata },
    { _tag: "Bytes", bytes: payload }
  );

test("downloads verify bytes, preserve destination races and symlinks, and remove staging", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "effectory-download-"));
  try {
    const destination = path.join(directory, "data.bin");
    const result = await Effect.runPromise(
      downloadToFile(frames(), request, destination)
    );
    expect(result.bytes).toBe(payload.length);
    expect(new Uint8Array(readFileSync(destination))).toEqual(payload);
    expect(readdirSync(directory)).toEqual(["data.bin"]);
    const repeated = await Effect.runPromise(
      downloadToFile(frames(), request, destination).pipe(Effect.flip)
    );
    expect(repeated.code).toBe("Conflict");
    const link = path.join(directory, "symlink.bin");
    symlinkSync(destination, link);
    const linked = await Effect.runPromise(
      downloadToFile(frames(), request, link).pipe(Effect.flip)
    );
    expect(linked.code).toBe("Conflict");
    const raced = path.join(directory, "race.bin");
    const racing = frames().pipe(
      Stream.concat(
        Stream.fromEffect(
          Effect.sync(() => {
            writeFileSync(raced, "concurrent");
            return { _tag: "Bytes" as const, bytes: new Uint8Array() };
          })
        )
      )
    );
    const race = await Effect.runPromise(
      downloadToFile(racing, request, raced).pipe(Effect.flip)
    );
    expect(race.code).toBe("Conflict");
    expect(readFileSync(raced, "utf-8")).toBe("concurrent");
    expect(
      readdirSync(directory).filter((name) => name.startsWith(".effectory"))
    ).toEqual([]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("invalid ordering, corruption, truncation and late RPC errors never install a file", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "effectory-download-invalid-")
  );
  try {
    const failures: Stream.Stream<DownloadFrame, OperationError>[] = [
      Stream.empty,
      Stream.succeed({ _tag: "Bytes", bytes: payload }),
      Stream.make(
        { _tag: "Metadata", metadata },
        { _tag: "Metadata", metadata }
      ),
      Stream.succeed({ _tag: "Metadata", metadata }),
      Stream.make(
        { _tag: "Metadata", metadata },
        { _tag: "Bytes", bytes: new Uint8Array(payload.length) }
      ),
      frames().pipe(
        Stream.concat(
          Stream.fail(
            new OperationError({
              code: "ContentUnavailable",
              message: "late integrity failure",
            })
          )
        )
      ),
      Stream.succeed({
        _tag: "Metadata",
        metadata: { ...metadata, version: 2 },
      }),
    ];
    for (const [index, source] of failures.entries()) {
      const output = path.join(directory, `case-${index}`);
      // oxlint-disable-next-line no-await-in-loop -- Assert cleanup before advancing to the next failure case.
      const error = await Effect.runPromise(
        downloadToFile(source, request, output).pipe(Effect.flip)
      );
      expect(error.code).toBe("ContentUnavailable");
      expect(existsSync(output)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("download interruption closes the source and removes its temporary file", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "effectory-download-cancel-")
  );
  let closed = false;
  try {
    const source = Stream.unwrap(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            closed = true;
          })
        );
        return Stream.succeed<DownloadFrame>({
          _tag: "Metadata",
          metadata,
        }).pipe(Stream.concat(Stream.never));
      })
    );
    const outcome = await Effect.runPromiseExit(
      downloadToFile(
        source,
        request,
        path.join(directory, "cancelled.bin")
      ).pipe(Effect.timeout("20 millis"))
    );
    expect(outcome._tag).toBe("Failure");
    expect(closed).toBe(true);
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

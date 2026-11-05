import { OperationError } from "@effectory/runtime/protocol";
import { Effect } from "effect";

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximum: number
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- Stream reads are sequential and bounded.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.length;
      if (size > maximum) {
        throw new OperationError({
          code: "LimitExceeded",
          message: "Subprocess output exceeds its byte limit",
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

/** No shell; cancellation kills the child and waits for process exit. */
export function runBounded(
  command: readonly string[],
  options: {
    readonly maximumBytes: number;
    readonly failure: () => OperationError;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  }
) {
  return Effect.acquireUseRelease(
    Effect.try({
      catch: options.failure,
      try: () =>
        Bun.spawn([...command], {
          env: options.environment ?? process.env,
          stderr: "pipe",
          stdin: "ignore",
          stdout: "pipe",
        }),
    }),
    (child) =>
      Effect.tryPromise({
        catch: (cause) =>
          cause instanceof OperationError ? cause : options.failure(),
        try: async () => {
          const [stdout, , exit] = await Promise.all([
            readBounded(child.stdout, options.maximumBytes),
            readBounded(child.stderr, 65_536),
            child.exited,
          ]);
          // Diagnostics can contain credentials or application data. Callers
          // supply a fixed message rather than forwarding subprocess stderr.
          if (exit !== 0) {
            throw options.failure();
          }
          return stdout;
        },
      }),
    (child) =>
      Effect.promise(async () => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
      })
  ).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(options.failure()),
    })
  );
}

import {
  requestControl,
  RuntimeClientError,
  startRuntime,
} from "@effectory/runtime";
import type { ControlMessage } from "@effectory/runtime/protocol";
import { Cause, Console, Effect, Exit, Schema } from "effect";

export const runtimeError = (error: unknown) =>
  new RuntimeClientError({
    message: error instanceof Error ? error.message : String(error),
  });

type Request = (
  message: ControlMessage
) => Effect.Effect<unknown, RuntimeClientError>;

/** A command owns a local session, or talks to an already running owner. */
export const withLocalRuntime = <A, E, R>(
  workspace: string,
  options: { execute?: boolean; loadTasks?: boolean; loadConfig?: boolean },
  use: (request: Request) => Effect.Effect<A, E, R>
) => {
  const remote: Request = (message) =>
    requestControl(workspace, message).pipe(Effect.mapError(runtimeError));
  const connected = requestControl(workspace, { method: "task.list" }).pipe(
    Effect.as(true),
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This callback recovers an Effect, not a Promise.
    Effect.catchTag("RuntimeClientError", (error) =>
      error.unavailable ? Effect.succeed(false) : Effect.fail(error)
    )
  );
  return connected.pipe(
    Effect.flatMap((available) =>
      available
        ? use(remote)
        : Effect.acquireUseRelease(
            Effect.tryPromise({
              catch: runtimeError,
              try: () => startRuntime(workspace, options),
            }),
            (runtime) => {
              const local: Request = (message) =>
                Effect.tryPromise({
                  catch: runtimeError,
                  try: () => runtime.request(message),
                });
              return use(local);
            },
            (runtime) => Effect.promise(() => runtime.close())
          )
    )
  );
};

export const requestLocal = (workspace: string, message: ControlMessage) =>
  withLocalRuntime(
    workspace,
    {
      execute: false,
      loadConfig:
        message.method === "artifact.list" || message.method === "artifact.get",
      loadTasks:
        message.method === "task.list" || message.method === "task.describe",
    },
    (request) => request(message)
  );

const Run = Schema.Struct({
  id: Schema.String,
  inspectionError: Schema.optional(Schema.String),
  status: Schema.String,
});
const Approvals = Schema.Array(
  Schema.Struct({
    released: Schema.optional(Schema.Boolean),
    runId: Schema.String,
    status: Schema.String,
  })
);

const waitForRun = (
  request: Request,
  id: string
): Effect.Effect<unknown, RuntimeClientError> =>
  Effect.gen(function* wait() {
    const value = yield* request({ id, method: "run.inspect" });
    const run = yield* Schema.decodeUnknownEffect(Run)(value).pipe(
      Effect.mapError(runtimeError)
    );
    if (
      ["succeeded", "failed", "cancelled"].includes(run.status) ||
      run.inspectionError
    ) {
      return value;
    }
    if (run.status === "suspended") {
      const approvals = yield* request({ method: "approval.list" }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Approvals)),
        Effect.mapError(runtimeError)
      );
      if (
        approvals.some(
          (approval) =>
            approval.runId === id &&
            (approval.status === "pending" ||
              (approval.status === "approved" && !approval.released))
        )
      ) {
        return value;
      }
    }
    yield* Effect.sleep("100 millis");
    return yield* waitForRun(request, id);
  });

/** Execution stays in the CLI until a terminal outcome or a durable approval pause. */
export const executeLocal = (
  workspace: string,
  message: Extract<ControlMessage, { method: "task.run" | "run.resume" }>
) =>
  withLocalRuntime(workspace, { execute: true }, (request) =>
    Effect.acquireUseRelease(
      request(message).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Run)),
        Effect.mapError(runtimeError)
      ),
      (initial) =>
        Effect.gen(function* execute() {
          yield* Console.error(
            JSON.stringify({ runId: initial.id, status: initial.status })
          );
          const value = yield* waitForRun(request, initial.id);
          yield* Console.log(JSON.stringify(value, null, 2));
          const result = yield* Schema.decodeUnknownEffect(Run)(value).pipe(
            Effect.mapError(runtimeError)
          );
          if (
            ["failed", "cancelled"].includes(result.status) ||
            result.inspectionError
          ) {
            return yield* runtimeError(
              `Run ${result.id}: ${result.inspectionError ?? result.status}`
            );
          }
        }),
      (initial, exit) =>
        Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
          ? request({ id: initial.id, method: "run.cancel" }).pipe(
              Effect.andThen(waitForRun(request, initial.id)),
              Effect.ignore
            )
          : Effect.void
    )
  );

export const cancelLocal = (workspace: string, id: string) =>
  withLocalRuntime(workspace, { execute: true }, (request) =>
    request({ id, method: "run.cancel" }).pipe(
      Effect.andThen(waitForRun(request, id)),
      Effect.flatMap((value) => Console.log(JSON.stringify(value, null, 2)))
    )
  );

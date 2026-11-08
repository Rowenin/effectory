import { Cause, Clock, Effect, Exit, Schema } from "effect";

import { AssertionFailed } from "./assertion-failed.ts";
import { identifier } from "./boundary.ts";
import type { CheckRecord } from "./check-schema.ts";
import {
  Severity,
  checkLimits,
  checkReservation,
  checkSettings,
} from "./check-schema.ts";
import { Checks } from "./checks.ts";
import { TaskRuntimeError } from "./errors.ts";
import type { publicationLifetime } from "./publication-lifetime.ts";
import type { Tracker } from "./vault-tracker.ts";
import { checkSerialized, scrub } from "./vault-tracker.ts";

export interface CheckStart {
  readonly id: string;
  readonly message: string;
  readonly severity: typeof Severity.Type;
}
export interface CheckFinish {
  readonly status: Exclude<CheckRecord["status"], "Running">;
  readonly message: string;
  readonly durationMillis: number | null;
}
export interface CheckBinding {
  readonly failOn: typeof Severity.Type;
  readonly start: (
    input: CheckStart
  ) => Effect.Effect<number, TaskRuntimeError>;
  readonly finish: (
    sequence: number,
    result: CheckFinish
  ) => Effect.Effect<void, TaskRuntimeError>;
}
const bindings = new WeakMap<object, CheckBinding>();
export const bindChecks = (runtime: object, binding: CheckBinding) => {
  bindings.set(runtime, binding);
};
const failure = (code: string, message: string) =>
  new TaskRuntimeError({ code, message });
const ranks = { high: 2, low: 0, medium: 1 };
const Input = Schema.Struct({
  id: Schema.String,
  message: Schema.String,
  severity: Schema.optionalKey(Severity),
});

export function checksFor(
  runtime: object,
  owner: ReturnType<typeof publicationLifetime>,
  tracker?: Tracker
) {
  const binding = bindings.get(runtime);
  return Checks.of({
    assert: (id, predicate, options) =>
      owner.run(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (!binding) {
              return yield* failure(
                "Unavailable",
                "Checks require an invocation binding"
              );
            }
            const input = yield* Effect.try({
              catch: (error) =>
                error instanceof TaskRuntimeError
                  ? error
                  : failure("InvalidBoundary", "Invalid assertion options"),
              try: () => {
                const value = Schema.decodeUnknownSync(Input)(
                  { ...options, id },
                  { onExcessProperty: "error" }
                );
                identifier(value.id);
                if (new TextEncoder().encode(value.message).byteLength > 2000) {
                  throw failure(
                    "LimitExceeded",
                    "Check message exceeds 2000 UTF-8 bytes"
                  );
                }
                return {
                  id: value.id,
                  message: scrub(tracker, value.message),
                  severity: value.severity ?? "high",
                };
              },
            });
            yield* checkSerialized(JSON.stringify(input.id), tracker);
            const sequence = yield* binding.start(input);
            const started = yield* Clock.currentTimeNanos;
            const exit = yield* Effect.exit(restore(predicate));
            const durationMillis =
              Number((yield* Clock.currentTimeNanos) - started) / 1_000_000;
            const interrupted =
              Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);
            const invalid =
              Exit.isSuccess(exit) && typeof exit.value !== "boolean";
            let status: CheckFinish["status"] = "Error";
            if (interrupted) {
              status = "Incomplete";
            } else if (Exit.isSuccess(exit) && !invalid) {
              status = exit.value ? "Passed" : "Failed";
            }
            let message = scrub(tracker, input.message);
            if (status === "Error") {
              message = "Assertion evaluation failed";
            }
            if (status === "Incomplete") {
              message = "Assertion evaluation did not finish";
            }
            const persisted = yield* Effect.exit(
              binding.finish(sequence, {
                durationMillis: Math.max(0, durationMillis),
                message,
                status,
              })
            );
            if (interrupted && Exit.isFailure(exit)) {
              return yield* Effect.failCause(exit.cause);
            }
            if (Exit.isFailure(persisted)) {
              return yield* Effect.failCause(persisted.cause);
            }
            if (Exit.isFailure(exit)) {
              return yield* Effect.failCause(exit.cause);
            }
            if (invalid) {
              return yield* failure(
                "InvalidBoundary",
                "Assertion predicate must return a boolean"
              );
            }
            if (!exit.value && ranks[input.severity] >= ranks[binding.failOn]) {
              return yield* new AssertionFailed({ ...input, message });
            }
          })
        )
      ),
  });
}

export function testChecks(
  identity: {
    readonly runId: string;
    readonly invocationPath: string;
    readonly taskId: string;
    readonly attempt: number;
  },
  options: unknown
) {
  const settings = checkSettings(options);
  const rows: CheckRecord[] = [];
  let bytes = 0;
  const binding: CheckBinding = {
    ...settings,
    finish: (sequence, result) =>
      Effect.sync(() => {
        const row = rows[sequence - 1];
        if (row) {
          rows[sequence - 1] = {
            ...row,
            ...result,
            durationMillis: 0,
            finishedAt: row.startedAt,
          };
        }
      }),
    start: (input) =>
      Effect.try({
        catch: (error) =>
          error instanceof TaskRuntimeError
            ? error
            : failure("Unavailable", "Check recording failed"),
        try: () => {
          if (rows.some((row) => row.id === input.id)) {
            throw failure(
              "InvalidBoundary",
              "Duplicate check id in this entry"
            );
          }
          const record: CheckRecord = {
            ...input,
            attempt: identity.attempt,
            durationMillis: null,
            entry: 1,
            finishedAt: null,
            nodeId: identity.invocationPath,
            runId: identity.runId,
            sequence: rows.length + 1,
            startedAt: new Date(rows.length).toISOString(),
            status: "Running",
            taskId: identity.taskId,
          };
          const reserved = checkReservation(record);
          if (
            rows.length >= checkLimits.entry ||
            reserved > checkLimits.recordBytes ||
            bytes + reserved > checkLimits.runBytes
          ) {
            throw failure("LimitExceeded", "Check observation budget exceeded");
          }
          bytes += reserved;
          rows.push(record);
          return record.sequence;
        },
      }),
  };
  return {
    binding,
    records: () => Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
  };
}

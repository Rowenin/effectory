import { Effect, Schema } from "effect";
import type { Duration } from "effect";

import type { Suspended } from "./errors.ts";
import { TaskTypeId } from "./task.ts";
import type { AnySchema, Task } from "./task.ts";

export interface TimerConfig<In extends AnySchema> {
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly input: In;
  /** How long to wait, from the Timer's input. */
  readonly wait: (input: In["Type"]) => Duration.Input;
}

/** A Timer's output: when it woke, in epoch milliseconds. */
export const WakeTime = Schema.Finite;

/**
 * Define a point where the run waits until a time. The wait starts the first
 * time a run reaches the node and is stored, so it survives the process.
 *
 * A Timer is a Task, so `After` and `Calls` accept it. A short wait happens in
 * the process; a longer one suspends the run until its wake time (see
 * `InProcessWait`).
 */
export const Timer = <const Name extends string, In extends AnySchema>(
  name: Name,
  config: TimerConfig<In>
): Task<Name, In, typeof WakeTime, Suspended> => ({
  [TaskTypeId]: { _E: (_) => _, _R: (_) => _ },
  body: () =>
    Effect.succeed({
      run: Effect.die(new Error(`${name} is a Timer; run waits for it`)),
    }),
  description: config.description,
  execution: {},
  input: config.input,
  kind: "timer",
  labels: config.labels ?? [],
  name,
  output: WakeTime,
  wait: config.wait,
});

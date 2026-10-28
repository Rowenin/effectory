import { Effect } from "effect";

import type { Suspended } from "./errors.ts";
import { TaskTypeId } from "./task.ts";
import type { AnySchema, BaseConfig, Task } from "./task.ts";

/**
 * Define a point where the run waits for a person. `input` is what they are
 * shown, `output` is what they send back.
 *
 * An Input is a Task, so `After` and `Calls` accept it. It has no work of its
 * own: `run` answers it from `responses`, or stops with `Suspended`.
 */
export const Input = <
  const Name extends string,
  In extends AnySchema,
  Out extends AnySchema,
>(
  name: Name,
  config: BaseConfig<In, Out>
): Task<Name, In, Out, Suspended> => ({
  [TaskTypeId]: { _E: (_) => _, _R: (_) => _ },
  body: () =>
    Effect.succeed({
      run: Effect.die(new Error(`${name} is an Input; run answers it`)),
    }),
  description: config.description,
  execution: {},
  input: config.input,
  kind: "input",
  labels: config.labels ?? [],
  name,
  output: config.output,
});

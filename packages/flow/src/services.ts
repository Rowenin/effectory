/** Context the runtime provides to Task code at plan time and at run time. */
import { Context } from "effect";
import type { Effect } from "effect";

import type { PlanError } from "./errors.ts";
import type { AnyTask } from "./task.ts";

/**
 * Collects `After` declarations while a Task body runs. Only `plan` provides
 * it; `Task` strips it from the resulting requirements.
 */
export class Planner extends Context.Service<
  Planner,
  {
    readonly after: (
      task: AnyTask,
      input: unknown
    ) => Effect.Effect<string, PlanError>;
  }
>()("effectory/flow/Planner") {}

/** Outputs of finished nodes by key; `run` provides a fresh map. */
export const Outputs = Context.Reference<Map<string, unknown>>(
  "effectory/flow/Outputs",
  { defaultValue: () => new Map() }
);

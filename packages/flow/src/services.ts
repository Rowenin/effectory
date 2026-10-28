/** Context the runtime provides to Task code at plan time and at run time. */
import { Context, Duration } from "effect";
import type { Effect } from "effect";

import type { PlanError } from "./errors.ts";
import type { AnyTask } from "./task.ts";

/** A Task a node may call at run time, declared with `Calls` in its body. */
export interface CallDeclaration {
  /** Key of the node whose body declared the call. */
  readonly caller: string;
  readonly task: AnyTask;
  readonly max: number | undefined;
}

/**
 * Collects `After` and `Calls` declarations while a Task body runs. Only the
 * planner provides it; `Task` strips it from the resulting requirements.
 */
export class Planner extends Context.Service<
  Planner,
  {
    readonly after: (
      task: AnyTask,
      input: unknown
    ) => Effect.Effect<string, PlanError>;
    readonly calls: (
      task: AnyTask,
      max: number | undefined
    ) => Effect.Effect<CallDeclaration>;
  }
>()("effectory/flow/Planner") {}

/** Outputs of finished nodes by key; `run` provides a fresh map. */
export const Outputs = Context.Reference<Map<string, unknown>>(
  "effectory/flow/Outputs",
  { defaultValue: () => new Map() }
);

/** The run in progress, through which declared calls start nodes. */
export interface Runtime {
  readonly call: (
    declaration: CallDeclaration,
    input: unknown
  ) => Effect.Effect<unknown, unknown>;
}

/** Set by `run`; unset while planning, so calling there is a defect. */
export const CurrentRun = Context.Reference<Runtime | null>(
  "effectory/flow/CurrentRun",
  { defaultValue: () => null }
);

/** Most nodes doing work at once in a run; Inputs and Timers don't count. */
export const Concurrency = Context.Reference<number | "unbounded">(
  "effectory/flow/Concurrency",
  { defaultValue: () => "unbounded" }
);

/**
 * Timers due within this long are waited for in the process; later ones
 * suspend the run until their wake time.
 */
export const InProcessWait = Context.Reference<Duration.Duration>(
  "effectory/flow/InProcessWait",
  { defaultValue: () => Duration.minutes(1) }
);

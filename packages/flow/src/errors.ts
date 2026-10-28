// oxlint-disable-next-line max-classes-per-file -- the package's errors live together.
import { Data } from "effect";

export class PlanError extends Data.TaggedError("PlanError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** An Input node the run reached without a response. */
export interface PendingInput {
  readonly key: string;
  readonly name: string;
  readonly description: string | undefined;
  /** The Input's encoded input: what to show the person. */
  readonly request: unknown;
  /** Why the last response was not accepted, if there was one. */
  readonly rejected?: string;
}

/**
 * The run stopped at Input nodes that have no response yet. Run the plan
 * again with `responses` for these keys to continue.
 */
export class Suspended extends Data.TaggedError("Suspended")<{
  readonly message: string;
  readonly pending: readonly PendingInput[];
}> {}

/**
 * A declared call that could not be made: it went over its `max`, would wait
 * on its own caller, or its node failed to plan.
 */
export class CallError extends Data.TaggedError("CallError")<{
  readonly reason: "limit" | "cycle" | "plan";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A `RunStore` could not read or write. */
export class StoreError extends Data.TaggedError("StoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

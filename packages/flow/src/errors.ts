import { Data } from "effect";

export class PlanError extends Data.TaggedError("PlanError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

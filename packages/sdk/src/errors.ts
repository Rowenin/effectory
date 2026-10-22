import { Data } from "effect";

export class RuntimeError extends Data.TaggedError("RuntimeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

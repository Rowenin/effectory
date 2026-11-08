import { TaskRuntimeError } from "@offtree/effectory-sdk";
import {
  checkJsonBudget,
  encode as encodeBoundary,
} from "@offtree/effectory-sdk/internal/boundary";
import type { Boundary } from "@offtree/effectory-sdk/internal/boundary";
import { Effect, Schema } from "effect";

/* oxlint-disable unicorn/throw-new-error */
export class ExecutionFailure extends Schema.TaggedError<
  ExecutionFailure,
  { readonly brand: unique symbol }
>()("ExecutionFailure", {
  category: Schema.Literals(["Domain", "Host", "Control"]),
  detail: Schema.Json,
  outcome: Schema.Literals(["Failed", "Rejected", "TimedOut", "Cancelled"]),
}) {}

export const hostFailure = (message: string, code?: string) =>
  new ExecutionFailure({
    category: "Host",
    detail: { message, ...(code === undefined ? {} : { code }) },
    outcome: "Failed",
  });
export const boundary = <A>(action: () => A) =>
  Effect.try({
    catch: (error) =>
      error instanceof TaskRuntimeError
        ? hostFailure(error.message, error.code)
        : hostFailure("Boundary validation failed"),
    try: action,
  });

export function encode(schema: Boundary, value: unknown): Schema.Json {
  const encoded = encodeBoundary(schema, value);
  checkJsonBudget(encoded);
  return encoded;
}

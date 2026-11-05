/* oxlint-disable unicorn/throw-new-error, max-classes-per-file */
// Schema factories return error classes; they are not constructor invocations.
import { Schema } from "effect";

export class DefinitionError extends Schema.TaggedError<
  DefinitionError,
  { readonly brand: unique symbol }
>()("DefinitionError", { message: Schema.String }) {}

export class TaskRuntimeError extends Schema.TaggedError<
  TaskRuntimeError,
  { readonly brand: unique symbol }
>()("TaskRuntimeError", { code: Schema.String, message: Schema.String }) {}

export function definitionError(error: unknown): DefinitionError {
  return error instanceof DefinitionError
    ? error
    : new DefinitionError({ message: String(error) });
}

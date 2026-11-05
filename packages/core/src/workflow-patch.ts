import { Effect, Schema } from "effect";

import { identifier } from "./boundary.ts";
import type { DefinitionError } from "./errors.ts";
import type * as Ref from "./ref.ts";
import type * as Task from "./task.ts";
import * as Workflow from "./workflow.ts";

export interface Definition<
  S extends Task.Spec = Task.Spec,
  Id extends string = string,
> {
  readonly id: Id;
  readonly target: Task.Contract<S>;
  readonly build: Effect.Effect<Workflow.Graph, DefinitionError>;
}

/** An additive graph with only the target invocation's input in scope. */
export function make<const S extends Task.Spec, const Id extends string>(
  spec: { readonly id: Id; readonly target: Task.Contract<S> },
  build: (
    input: Ref.Ref<NoInfer<S["input"]["Type"]>>
  ) => Effect.Effect<void, DefinitionError, Workflow.Builder>
): Definition<S, Id> {
  identifier(spec.id);
  const graph = Workflow.make(
    {
      error: Schema.Never,
      id: spec.id,
      input: spec.target.inputSchema,
      success: Schema.Null,
      version: 1,
    },
    Effect.gen(function* () {
      const builder = yield* Workflow.Builder;
      const input = yield* builder.input(spec.target.inputSchema);
      yield* build(input);
      return null;
    })
  );
  return Object.freeze({ ...spec, build: graph.build });
}

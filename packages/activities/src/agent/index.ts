import { AutomationError, InTask } from "@effectory/sdk";
import type { Codec } from "@effectory/sdk/authoring";
import { Context, Effect, Layer, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { ProcessError } from "../internal/spawn.ts";
import {
  AgentError,
  CallInput,
  ClaudeSpec,
  CodexSpec,
  invoke,
  jsonSchemaOf,
  provenance,
} from "./provider.ts";
import type { Spec } from "./provider.ts";

export { Access, AgentError, Effort } from "./provider.ts";
export type { Spec } from "./provider.ts";

export const RunResult = Schema.Struct({
  ...provenance,
  output: Schema.String,
});

/** The result of `generate` for an output schema. */
export const GenerateResult = <S extends Codec>(schema: S) =>
  Schema.Struct({ ...provenance, value: schema });

/** Errors a Task that calls an agent can fail with. */
export const Failure = Schema.Union([
  ProcessError,
  AgentError,
  AutomationError,
]);

export type RunInput = typeof CallInput.Type;
export type GenerateInput<S extends Codec> = RunInput & { readonly schema: S };

/** A configured coding agent. Calls run its CLI once; nothing is recorded. */
class Agent extends Context.Service<
  Agent,
  {
    readonly spec: Spec;
    readonly run: (
      input: RunInput
    ) => Effect.Effect<typeof RunResult.Type, typeof Failure.Type>;
    readonly generate: <S extends Codec>(
      input: GenerateInput<S>
    ) => Effect.Effect<
      Schema.Struct<typeof provenance & { value: S }>["Type"],
      typeof Failure.Type
    >;
  }
>()("effectory/Agent") {}
export { Agent as Service };

/** A Claude Code spec. Invalid settings throw where the spec is made. */
export const Claude = {
  make: (spec: Omit<typeof ClaudeSpec.Type, "provider"> = {}): Spec =>
    Schema.decodeSync(ClaudeSpec)({ ...spec, provider: "claude" }),
};

/** A Codex spec. Invalid settings throw where the spec is made. */
export const Codex = {
  make: (spec: Omit<typeof CodexSpec.Type, "provider"> = {}): Spec =>
    Schema.decodeSync(CodexSpec)({ ...spec, provider: "codex" }),
};

const invalidInput = (operation: string) => (cause: unknown) =>
  new AutomationError({
    message: String(cause),
    operation,
    reason: "invalid-input",
  });

/** The Agent layer for a spec, e.g. `Agent.make(Claude.make({ model }))`. */
export const make = (spec: Spec) =>
  Layer.effect(
    Agent,
    Effect.gen(function* makeAgent() {
      const platform = {
        fs: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        spawner: yield* ChildProcessSpawner,
      };
      return Agent.of({
        generate: <S extends Codec>({ schema, ...input }: GenerateInput<S>) =>
          Schema.decodeEffect(CallInput)(input).pipe(
            Effect.mapError(invalidInput("agent.generate")),
            Effect.flatMap((call) =>
              invoke(platform, spec, {
                call,
                jsonSchema: jsonSchemaOf(schema),
                operation: "agent.generate",
              })
            ),
            Effect.flatMap((outcome) =>
              Schema.decodeUnknownEffect(Schema.toCodecJson(schema))(
                outcome.structured
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new AutomationError({
                      message: `Structured output does not match the schema: ${cause}`,
                      operation: "agent.generate",
                      reason: "invalid-output",
                    })
                ),
                Effect.map((value) => ({ ...outcome.provenance, value }))
              )
            )
          ),
        run: (input) =>
          Schema.decodeEffect(CallInput)(input).pipe(
            Effect.mapError(invalidInput("agent.run")),
            Effect.flatMap((call) =>
              invoke(platform, spec, {
                call,
                jsonSchema: undefined,
                operation: "agent.run",
              })
            ),
            Effect.map((outcome) => ({
              ...outcome.provenance,
              output: outcome.text,
            }))
          ),
        spec,
      });
    })
  );

/**
 * Run a prompt and return the agent's final answer. Only callable inside a
 * Task, which records the result.
 */
export const run = (input: RunInput) =>
  Effect.gen(function* runInTask() {
    yield* InTask;
    const agent = yield* Agent;
    return yield* agent.run(input);
  });

/**
 * Generate a value of `schema` through the provider's structured output
 * channel (`claude --json-schema`, `codex exec --output-schema`), decoded
 * from its JSON form. Model optional fields as `Schema.NullOr`: Codex
 * requires every property to be present. Only callable inside a Task.
 */
export const generate = <S extends Codec>(input: GenerateInput<S>) =>
  Effect.gen(function* generateInTask() {
    yield* InTask;
    const agent = yield* Agent;
    return yield* agent.generate(input);
  });

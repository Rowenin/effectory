/* oxlint-disable max-classes-per-file -- the Agent service and its errors are one module. */
/**
 * Coding agents (Claude Code, Codex) as a service plus recorded Actions.
 *
 * - `Agent.make(Claude.make({ model }))` is the service layer; it runs the
 *   provider CLI once per call and records nothing.
 * - `Agent.Prompt` is the Action that records a prompt's answer with
 *   provenance; `Agent.structured(type, schema)` makes an Action that records a
 *   schema-enforced value.
 *
 * Agent Actions keep the default `retry: "auto"`: an interrupted call reruns
 * on resume, starting from whatever the interrupted attempt left behind.
 */
import { Action } from "@effectory/core";
import { Context, Effect, Layer, Option, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import type { ProcessError } from "../internal/spawn.ts";
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

export { Access, AgentError, CallInput, Effort } from "./provider.ts";
export type { Spec } from "./provider.ts";

/** A schema usable for persistence and decoding without services. */
export interface Codec extends Schema.Top {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
}

/** Non-secret record of how an agent call ran. */
export const Provenance = Schema.Struct(provenance);

export const RunResult = Schema.Struct({
  ...provenance,
  output: Schema.String,
});

/** The result of `generate` (and `structured` Actions) for an output schema. */
export const GenerateResult = <S extends Codec>(schema: S) =>
  Schema.Struct({ ...provenance, value: schema });

export type RunInput = typeof CallInput.Type;
export type GenerateInput<S extends Codec> = RunInput & { readonly schema: S };
export type GenerateOutput<S extends Codec> = ReturnType<
  typeof GenerateResult<S>
>["Type"];

/** Errors an agent call can fail with. */
export type Failure = ProcessError | AgentError;

/** A configured coding agent. Calls run its CLI once; nothing is recorded. */
export class Service extends Context.Service<
  Service,
  {
    readonly spec: Spec;
    readonly run: (
      input: RunInput
    ) => Effect.Effect<typeof RunResult.Type, Failure>;
    readonly generate: <S extends Codec>(
      input: GenerateInput<S>
    ) => Effect.Effect<GenerateOutput<S>, Failure>;
  }
>()("effectory/Agent") {}

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

const invalidInput = (spec: Spec) => (cause: unknown) =>
  new AgentError({
    message: `Invalid agent input: ${String(cause)}`,
    provider: spec.provider,
    reason: "invalid-input",
  });

const decodeStructured = <S extends Codec>(
  schema: S,
  provider: Spec["provider"],
  value: unknown
) =>
  Schema.decodeUnknownEffect(Schema.toCodecJson(schema))(value).pipe(
    Effect.mapError(
      (cause) =>
        new AgentError({
          message: `Structured output does not match the schema: ${cause}`,
          provider,
          reason: "invalid-output",
        })
    )
  );

/** The Agent layer for a spec, e.g. `Agent.make(Claude.make({ model }))`. */
export const make = (
  spec: Spec
): Layer.Layer<
  Service,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> =>
  Layer.effect(
    Service,
    Effect.gen(function* makeAgent() {
      const platform = {
        fs: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        spawner: yield* ChildProcessSpawner,
      };
      return Service.of({
        generate: <S extends Codec>({ schema, ...input }: GenerateInput<S>) =>
          Schema.decodeEffect(CallInput)(input).pipe(
            Effect.mapError(invalidInput(spec)),
            Effect.flatMap((call) =>
              invoke(platform, spec, { call, jsonSchema: jsonSchemaOf(schema) })
            ),
            Effect.flatMap((outcome) =>
              decodeStructured(schema, spec.provider, outcome.structured).pipe(
                Effect.map(
                  (value) =>
                    ({ ...outcome.provenance, value }) as GenerateOutput<S>
                )
              )
            )
          ),
        run: (input) =>
          Schema.decodeEffect(CallInput)(input).pipe(
            Effect.mapError(invalidInput(spec)),
            Effect.flatMap((call) =>
              invoke(platform, spec, { call, jsonSchema: undefined })
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

/** Run a prompt and return the agent's final answer. Not recorded; see `Prompt`. */
export const run = (input: RunInput) =>
  Effect.flatMap(Service, (agent) => agent.run(input));

/**
 * Generate a value of `schema` through the provider's structured output
 * channel (`claude --json-schema`, `codex exec --output-schema`), decoded
 * from its JSON form. Model optional fields as `Schema.NullOr`: Codex
 * requires every property to be present. Not recorded; see `structured`.
 */
export const generate = <S extends Codec>(input: GenerateInput<S>) =>
  Effect.flatMap(Service, (agent) => agent.generate(input));

const fakeProvenance = (input: RunInput) =>
  Effect.map(Effect.serviceOption(Service), (agent) => {
    const spec = Option.getOrUndefined(agent)?.spec;
    return {
      access: input.access ?? spec?.access ?? "read-only",
      durationMs: 0,
      effort: input.effort ?? spec?.effort ?? null,
      models: [],
      provider: spec?.provider ?? "claude",
      requestedModel: input.model ?? spec?.model ?? null,
      sessionId: null,
      totalCostUsd: null,
    } satisfies typeof Provenance.Type;
  });

/** What `Prompt` records in fake mode for a prompt. */
export const fakeOutput = (prompt: string) =>
  `[fake agent] ${prompt.split("\n", 1)[0] ?? ""}`;

/**
 * Ask the configured agent and record its answer with provenance. In fake
 * mode no CLI runs; the answer is `[fake agent] <first line of the prompt>`.
 */
export const Prompt = Action.make("Agent.Prompt", {
  description: "Run a prompt through the configured coding agent",
  fake: (input) =>
    Effect.map(fakeProvenance(input), (recorded) => ({
      ...recorded,
      output: fakeOutput(input.prompt),
    })),
  input: CallInput,
  output: RunResult,
  run,
});

/** Fails a `structured` Action in fake mode when it has no fake value. */
// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError is a schema class factory.
export class MissingFake extends Schema.TaggedError<
  MissingFake,
  { readonly brand: unique symbol }
>()("MissingFake", {
  message: Schema.String,
  type: Schema.String,
}) {}

export interface StructuredOptions<S extends Codec> {
  readonly description?: string;
  readonly rerun?: "always" | "on-change";
  readonly retry?: "auto" | "never";
  /**
   * The value recorded in fake mode, or a function of the input producing
   * it. Without it, the Action fails in fake mode instead of calling an agent.
   * A function's literal fields may need `as const` to match literal schemas.
   */
  readonly fake?:
    | NoInfer<S["Type"]>
    | ((input: RunInput) => NoInfer<S["Type"]>);
}

/**
 * An Action that asks the configured agent for a value of `schema` and records
 * `{ ...provenance, value }`.
 *
 * ```ts
 * const Review = Agent.structured("Review", Findings, { fake: { findings: [] } });
 * const review = yield* Review("review", { prompt, cwd: checkout.path });
 * ```
 */
export const structured = <const Type extends string, S extends Codec>(
  type: Type,
  schema: S,
  options: StructuredOptions<S> = {}
) => {
  const { fake } = options;
  return Action.make(type, {
    description:
      options.description ?? `Generate a ${type} value with the coding agent`,
    fake: (input: RunInput) =>
      Effect.gen(function* fakeStructured() {
        if (fake === undefined) {
          return yield* new MissingFake({
            message: `${type} has no fake value; pass Agent.structured(..., { fake }) to run it in fake mode`,
            type,
          });
        }
        const recorded = yield* fakeProvenance(input);
        const value: S["Type"] =
          typeof fake === "function"
            ? (fake as (input: RunInput) => S["Type"])(input)
            : fake;
        return { ...recorded, value } as GenerateOutput<S>;
      }),
    input: CallInput,
    output: GenerateResult(schema),
    ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    run: (input: RunInput) => generate({ ...input, schema }),
  });
};

/**
 * An Agent layer that answers without running a CLI, for tests. `respond`
 * gets each call's input; `run` records a string response as is and anything
 * else as JSON, and `generate` decodes the response with the call's schema.
 */
export const fake = (
  respond: (input: RunInput) => unknown,
  spec: Spec = Claude.make()
): Layer.Layer<Service> => {
  const recorded = (input: RunInput) => ({
    access: input.access ?? spec.access ?? "read-only",
    durationMs: 0,
    effort: input.effort ?? spec.effort ?? null,
    models: [],
    provider: spec.provider,
    requestedModel: input.model ?? spec.model ?? null,
    sessionId: null,
    totalCostUsd: null,
  });
  return Layer.succeed(
    Service,
    Service.of({
      generate: <S extends Codec>({ schema, ...input }: GenerateInput<S>) =>
        Effect.suspend(() =>
          decodeStructured(schema, spec.provider, respond(input))
        ).pipe(
          Effect.map(
            (value) => ({ ...recorded(input), value }) as GenerateOutput<S>
          )
        ),
      run: (input) =>
        Effect.sync(() => {
          const response = respond(input);
          return {
            ...recorded(input),
            output:
              typeof response === "string"
                ? response
                : JSON.stringify(response),
          };
        }),
      spec,
    })
  );
};

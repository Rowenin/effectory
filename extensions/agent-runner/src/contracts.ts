/* oxlint-disable unicorn/throw-new-error, max-classes-per-file -- Schema factories define the public error and service identities. */
import {
  Artifact,
  ArtifactStorage,
  DefinitionError,
  Task,
} from "@offtree/effectory-sdk";
import { Context, Effect, Layer, Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import type { Options } from "./options.ts";

export type {
  Adapter,
  AdapterRequest,
  Options,
  Platform,
  Policy,
} from "./options.ts";

const Name = Schema.NonEmptyString.check(Schema.isMaxLength(200));
export const SessionReference = Schema.Struct({
  configuration: Name,
  platform: Name,
  policy: Name,
  sessionId: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u)
  ),
  workingDirectory: Schema.NonEmptyString,
});
export const Input = Schema.Struct({
  model: Schema.optionalKey(Name),
  options: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  platform: Name,
  policy: Name,
  prompt: Schema.NonEmptyString.check(Schema.isMaxLength(131_072)),
  resume: Schema.optionalKey(SessionReference),
  retainTranscript: Schema.optionalKey(Schema.Boolean),
  workingDirectory: Schema.NonEmptyString,
});
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const Usage = Schema.Struct({
  cachedInputTokens: Schema.optionalKey(Count),
  costUsd: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  inputTokens: Schema.optionalKey(Count),
  outputTokens: Schema.optionalKey(Count),
  reasoningOutputTokens: Schema.optionalKey(Count),
});
export const SessionResult = Schema.Struct({
  output: Schema.String.check(Schema.isMaxLength(131_072)),
  platform: Name,
  reportedModel: Schema.optionalKey(Name),
  requestedModel: Schema.optionalKey(Name),
  session: Schema.optionalKey(SessionReference),
  usage: Schema.optionalKey(Usage),
  version: Name,
  workingDirectory: Schema.NonEmptyString,
});
export class AgentError extends Schema.TaggedError<
  AgentError,
  { readonly brand: unique symbol }
>()("AgentError", {
  code: Schema.Literals([
    "InvalidConfiguration",
    "UnsupportedOption",
    "Authentication",
    "PermissionDenied",
    "CapacityLimit",
    "ProtocolError",
    "ExecutionFailed",
    "OutputLimit",
    "Timeout",
    "SessionBusy",
    "InvalidStructuredOutput",
  ]),
  message: Schema.String,
  session: Schema.optionalKey(SessionReference),
}) {}
export const Result = Artifact.make({
  id: "offtree/agent-runner/result",
  schema: SessionResult,
  version: 1,
});
export const Transcript = Artifact.make({
  id: "offtree/agent-runner/transcript",
  schema: Schema.Array(Schema.Json),
  version: 1,
});
export const RunSession = Task.contract({
  error: AgentError,
  id: "offtree/agent-runner/run-session",
  input: Input,
  outputs: { result: Result, transcript: Transcript },
  replay: "manual",
  success: SessionResult,
  version: 1,
});
export class AgentRunner extends Context.Service<
  AgentRunner,
  {
    readonly run: (
      input: typeof Input.Type,
      progress: (message: string) => Effect.Effect<void>,
      outputSchema?: Schema.Json
    ) => Effect.Effect<
      {
        readonly result: typeof SessionResult.Type;
        readonly transcript: readonly Schema.Json[];
      },
      AgentError
    >;
  }
>()("offtree/agent-runner/AgentRunner") {}

function invalidOutput<A, E>(effect: Effect.Effect<A, E>) {
  return effect.pipe(
    Effect.mapError(
      () =>
        new AgentError({
          code: "InvalidStructuredOutput",
          message: "Agent response does not match the declared output schema",
        })
    )
  );
}

function jsonSchema(schema: Schema.Codec<unknown, unknown>) {
  try {
    const document = Schema.toJsonSchemaDocument(schema, {
      onExcessProperty: "error",
    });
    const value = Schema.decodeUnknownSync(Schema.Json)({
      additionalProperties: false,
      properties: { output: document.schema },
      required: ["output"],
      type: "object",
      ...(Object.keys(document.definitions).length === 0
        ? {}
        : { $defs: document.definitions }),
    });
    if (Buffer.byteLength(JSON.stringify(value)) > 65_536) {
      throw new Error("Schema limit");
    }
    return value;
  } catch {
    throw new DefinitionError({
      message:
        "Agent output schema cannot be represented as a bounded JSON Schema",
    });
  }
}

/** Declare the output codec in source so task history retains its exact contract. */
export function makeTask<const S extends Schema.Codec<unknown, unknown>>(spec: {
  readonly id: string;
  readonly version: number;
  readonly output: S;
  readonly format?: "text" | "json";
}) {
  const format =
    spec.format ?? (spec.output.ast === Schema.String.ast ? "text" : "json");
  const codec = Schema.toCodecJson(spec.output);
  if (format === "text" && Schema.toEncoded(codec).ast._tag !== "String") {
    throw new DefinitionError({
      message: "Text output requires a string-encoded schema",
    });
  }
  const outputSchema = format === "json" ? jsonSchema(codec) : undefined;
  const success = Schema.Struct({ ...SessionResult.fields, output: codec });
  const resultArtifact = Artifact.make({
    id: `${spec.id}/result`,
    schema: success,
    version: spec.version,
  });
  return Task.make(
    {
      error: AgentError,
      id: spec.id,
      input: Input,
      outputs: { result: resultArtifact, transcript: Transcript },
      replay: "manual",
      success,
      version: spec.version,
    },
    (input, context) =>
      Effect.gen(function* () {
        const runner = yield* AgentRunner;
        const { result, transcript } = yield* runner.run(
          input,
          (message) => context.progress({ message }),
          outputSchema
        );
        const candidate =
          format === "json"
            ? (yield* Schema.decodeEffect(
                Schema.fromJsonString(Schema.Struct({ output: Schema.Json }))
              )(result.output, { onExcessProperty: "error" }).pipe(
                invalidOutput
              )).output
            : result.output;
        const value = yield* Schema.decodeUnknownEffect(success)(
          { ...result, output: candidate },
          { onExcessProperty: "error" }
        ).pipe(invalidOutput);
        const storage = yield* ArtifactStorage;
        yield* storage.publish(resultArtifact, value, {
          key: "result",
          output: "result",
        });
        if (input.retainTranscript === true) {
          yield* context.publish("transcript", [...transcript], {
            key: "transcript",
          });
        }
        return value;
      })
  );
}

/** Pure factory: implementations and provider SDKs load only on Layer acquisition. */
export function layer<R = never, E = never>(
  options: Options<R, E>
): Layer.Layer<
  AgentRunner,
  DefinitionError,
  ChildProcessSpawner | FileSystem | R
> {
  return Layer.unwrap(
    Effect.tryPromise({
      catch: () =>
        new DefinitionError({ message: "Agent runner could not be loaded" }),
      try: async () => {
        const runtime = await import("./runner.ts");
        return runtime.layer(options);
      },
    })
  );
}
export const contracts = {
  AgentError,
  AgentRunner,
  artifacts: { Result, Transcript },
  id: "offtree/agent-runner",
  layer,
  makeTask,
  tasks: { RunSession },
  // x-release-please-start-version
  version: "0.3.0",
  // x-release-please-end
  workflows: {},
};

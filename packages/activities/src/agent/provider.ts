import { AutomationError } from "@effectory/sdk";
import { Effect, Schema } from "effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { spawn } from "../internal/spawn.ts";

const nonEmpty = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 && !value.includes("\0"), {
    expected: "a nonempty string without NUL characters",
  })
);
// Values passed as separate arguments must not be mistaken for flags.
const value = nonEmpty.check(
  Schema.makeFilter((input) => !input.startsWith("-"), {
    expected: "a value that does not start with '-'",
  })
);
const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const envName = Schema.String.check(Schema.isPattern(/^[A-Z_a-z]\w*$/u));

export const Effort = Schema.Literals([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
/**
 * What the agent may touch. `none` runs without tools (Claude only);
 * `read-only` allows reading the workspace; `workspace-write` allows edits.
 */
export const Access = Schema.Literals(["none", "read-only", "workspace-write"]);

const common = {
  addDirs: Schema.optionalKey(Schema.Array(value)),
  // Name of a runner environment variable holding an API key, read when a
  // call runs. Without it the CLI uses its inherited environment or login.
  apiKeyEnv: Schema.optionalKey(envName),
  cwd: Schema.optionalKey(nonEmpty),
  effort: Schema.optionalKey(Effort),
  // Installed CLI; defaults to `claude` or `codex` on PATH.
  executable: Schema.optionalKey(nonEmpty),
  maxOutputBytes: Schema.optionalKey(positiveInteger),
  model: Schema.optionalKey(value),
  timeoutMs: Schema.optionalKey(positiveInteger),
};

export const ClaudeSpec = Schema.Struct({
  ...common,
  access: Schema.optionalKey(Access),
  appendSystemPrompt: Schema.optionalKey(nonEmpty),
  // Plugin directories (skills, agents, commands) loaded for each call.
  pluginDirs: Schema.optionalKey(Schema.Array(value)),
  provider: Schema.Literal("claude"),
});

export const CodexSpec = Schema.Struct({
  ...common,
  access: Schema.optionalKey(Schema.Literals(["read-only", "workspace-write"])),
  provider: Schema.Literal("codex"),
});

const AgentSpec = Schema.Union([ClaudeSpec, CodexSpec]);
export type Spec = typeof AgentSpec.Type;

/** Per-call input; anything omitted comes from the agent's spec. */
export const CallInput = Schema.Struct({
  access: Schema.optionalKey(Access),
  cwd: Schema.optionalKey(nonEmpty),
  effort: Schema.optionalKey(Effort),
  model: Schema.optionalKey(value),
  prompt: Schema.String.check(Schema.isMinLength(1)),
  timeoutMs: Schema.optionalKey(positiveInteger),
});

/** Non-secret record of how an agent call ran, included in every result. */
export const provenance = {
  access: Access,
  durationMs: Schema.Finite,
  effort: Schema.NullOr(Effort),
  // Models the CLI reported using, when it reports them.
  models: Schema.Array(Schema.String),
  provider: Schema.Literals(["claude", "codex"]),
  requestedModel: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  totalCostUsd: Schema.NullOr(Schema.Finite),
};

// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError is a schema class factory.
export class AgentError extends Schema.TaggedError<
  AgentError,
  { readonly brand: unique symbol }
>()("AgentError", {
  message: Schema.String,
  provider: Schema.Literals(["claude", "codex"]),
  reason: Schema.Literals(["auth", "agent-failed", "io"]),
}) {}

const apiKeyNames = { claude: "ANTHROPIC_API_KEY", codex: "CODEX_API_KEY" };
// Tool lists restrict Claude; they are not OS isolation.
const claudeTools = (access: typeof Access.Type, skills: boolean) => {
  if (access === "workspace-write") {
    return ["--permission-mode", "acceptEdits"];
  }
  if (access === "none") {
    return ["--tools", ""];
  }
  return ["--tools", skills ? "Read,Grep,Glob,Skill" : "Read,Grep,Glob"];
};

const ClaudeResult = Schema.Struct({
  is_error: Schema.Boolean,
  modelUsage: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  result: Schema.optionalKey(Schema.String),
  session_id: Schema.optionalKey(Schema.String),
  structured_output: Schema.optionalKey(Schema.Unknown),
  subtype: Schema.String,
  total_cost_usd: Schema.optionalKey(Schema.Finite),
  type: Schema.Literal("result"),
});

export interface Outcome {
  readonly provenance: Schema.Struct<typeof provenance>["Type"];
  readonly text: string;
  // The schema-enforced value when a JSON Schema was requested.
  readonly structured: unknown;
}

export interface Platform {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly spawner: ChildProcessSpawner["Service"];
}

interface Request {
  readonly call: typeof CallInput.Type;
  readonly jsonSchema: object | undefined;
  readonly operation: string;
}

/** What a provider reports about a finished turn. */
type Reported = Omit<Outcome, "provenance"> &
  Pick<Outcome["provenance"], "models" | "sessionId" | "totalCostUsd">;

/** Provider arguments for one turn, and how to read its result. */
interface Turn {
  readonly args: readonly string[];
  readonly finish: (
    stdout: string
  ) => Effect.Effect<Reported, AgentError | AutomationError>;
}

const flag = (name: string, flagValue: string | undefined) =>
  flagValue === undefined ? [] : [name, flagValue];
const addDirs = (spec: Spec) =>
  (spec.addDirs ?? []).flatMap((dir) => ["--add-dir", dir]);
const invalidOutput = (operation: string, message: string) =>
  new AutomationError({ message, operation, reason: "invalid-output" });

const accessOf = (spec: Spec, call: typeof CallInput.Type) =>
  call.access ?? spec.access ?? "read-only";
const ioError = (cause: PlatformError) =>
  new AgentError({
    message: `Agent workspace failed (${cause.reason._tag})`,
    provider: "codex",
    reason: "io",
  });

const claudeTurn = (
  spec: typeof ClaudeSpec.Type,
  { call, jsonSchema, operation }: Request
): Turn => ({
  args: [
    "--print",
    "--output-format",
    "json",
    "--no-session-persistence",
    // Configured MCP servers would add tools outside the access level.
    "--strict-mcp-config",
    ...flag("--model", call.model ?? spec.model),
    ...flag("--effort", call.effort ?? spec.effort),
    ...flag("--json-schema", jsonSchema && JSON.stringify(jsonSchema)),
    ...flag("--append-system-prompt", spec.appendSystemPrompt),
    ...(spec.pluginDirs ?? []).flatMap((dir) => ["--plugin-dir", dir]),
    ...addDirs(spec),
    ...claudeTools(accessOf(spec, call), (spec.pluginDirs ?? []).length > 0),
  ],
  finish: (stdout) =>
    Effect.gen(function* finishClaude() {
      const reply = yield* Schema.decodeEffect(
        Schema.fromJsonString(ClaudeResult)
      )(stdout.trim()).pipe(
        Effect.mapError((cause) =>
          invalidOutput(operation, `Unexpected Claude output: ${cause}`)
        )
      );
      if (reply.is_error || reply.subtype !== "success") {
        return yield* new AgentError({
          message: `Claude finished with ${reply.subtype}: ${reply.result ?? ""}`,
          provider: "claude",
          reason: "agent-failed",
        });
      }
      if (jsonSchema && reply.structured_output === undefined) {
        return yield* invalidOutput(
          operation,
          "Claude returned no structured output"
        );
      }
      return {
        models: Object.keys(reply.modelUsage ?? {}),
        sessionId: reply.session_id ?? null,
        structured: reply.structured_output,
        text: reply.result ?? "",
        totalCostUsd: reply.total_cost_usd ?? null,
      };
    }),
});

// Codex reads its schema from, and writes its final message to, files.
const codexTurn = (
  { fs, path }: Platform,
  spec: typeof CodexSpec.Type,
  { call, jsonSchema, operation }: Request
) =>
  Effect.gen(function* prepareCodex() {
    const directory = yield* fs
      .makeTempDirectoryScoped()
      .pipe(Effect.mapError(ioError));
    const schemaFile = path.join(directory, "schema.json");
    const messageFile = path.join(directory, "message.txt");
    if (jsonSchema) {
      yield* fs
        .writeFileString(schemaFile, JSON.stringify(jsonSchema))
        .pipe(Effect.mapError(ioError));
    }
    const model = call.model ?? spec.model;
    const effort = call.effort ?? spec.effort;
    const finish = () =>
      Effect.gen(function* finishCodex() {
        const text = yield* fs
          .readFileString(messageFile)
          .pipe(
            Effect.mapError(() =>
              invalidOutput(operation, "Codex wrote no final message")
            )
          );
        const structured = jsonSchema
          ? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
              text
            ).pipe(
              Effect.mapError((cause) =>
                invalidOutput(
                  operation,
                  `Codex structured output is not JSON: ${cause}`
                )
              )
            )
          : undefined;
        return {
          // `codex exec` reports neither on its final-message channel.
          models: model === undefined ? [] : [model],
          sessionId: null,
          structured,
          text,
          totalCostUsd: null,
        };
      });
    return {
      args: [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--sandbox",
        accessOf(spec, call),
        ...flag("--model", model),
        ...flag("--config", effort && `model_reasoning_effort="${effort}"`),
        ...(jsonSchema ? ["--output-schema", schemaFile] : []),
        ...addDirs(spec),
        "--output-last-message",
        messageFile,
        "-",
      ],
      finish,
    } satisfies Turn;
  });

/** Resolve a configured API key into the provider's variable, at call time. */
const authEnv = (spec: Spec) => {
  if (spec.apiKeyEnv === undefined) {
    return Effect.succeed({});
  }
  const key = process.env[spec.apiKeyEnv];
  return key
    ? Effect.succeed({ [apiKeyNames[spec.provider]]: key })
    : Effect.fail(
        new AgentError({
          message: `Environment variable ${spec.apiKeyEnv} is not set`,
          provider: spec.provider,
          reason: "auth",
        })
      );
};

/**
 * Run one non-interactive agent turn with the prompt on stdin. With
 * `jsonSchema`, the provider enforces the schema and `structured` holds its
 * value; nothing is parsed out of free text.
 */
export const invoke = (platform: Platform, spec: Spec, request: Request) =>
  Effect.gen(function* invokeAgent() {
    const { call } = request;
    const access = accessOf(spec, call);
    if (spec.provider === "codex" && access === "none") {
      return yield* new AutomationError({
        message: "Codex has no access level without tools",
        operation: request.operation,
        reason: "invalid-input",
      });
    }
    const env = yield* authEnv(spec);
    const turn =
      spec.provider === "claude"
        ? claudeTurn(spec, request)
        : yield* codexTurn(platform, spec, request);
    const cwd = call.cwd ?? spec.cwd;
    const result = yield* spawn({
      args: turn.args,
      command: spec.executable ?? spec.provider,
      env,
      stdin: call.prompt,
      ...(cwd === undefined ? {} : { cwd }),
      ...(spec.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: spec.maxOutputBytes }),
      timeoutMs: call.timeoutMs ?? spec.timeoutMs ?? 10 * 60_000,
    }).pipe(Effect.provideService(ChildProcessSpawner, platform.spawner));
    const { models, sessionId, structured, text, totalCostUsd } =
      yield* turn.finish(result.stdout);
    return {
      provenance: {
        access,
        durationMs: result.durationMs,
        effort: call.effort ?? spec.effort ?? null,
        models,
        provider: spec.provider,
        requestedModel: call.model ?? spec.model ?? null,
        sessionId,
        totalCostUsd,
      },
      structured,
      text,
    } satisfies Outcome;
  }).pipe(Effect.scoped);

/**
 * JSON Schema for a provider's structured output channel. Objects are closed,
 * as OpenAI strict schemas require; model optional fields as `NullOr`.
 */
export const jsonSchemaOf = (schema: Schema.Top) => {
  const document = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: "error",
  });
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions };
};

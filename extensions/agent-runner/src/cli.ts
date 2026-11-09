import path from "node:path";

import { Effect, Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";

import { AgentError, Usage } from "./contracts.ts";
import type { Adapter, AdapterRequest, Platform } from "./options.ts";
import { command } from "./process.ts";
import type { Spawner } from "./process.ts";

export function object(
  value: Schema.Json | undefined
): Record<string, Schema.Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
function text(value: Schema.Json | undefined) {
  return typeof value === "string" ? value : undefined;
}
function number(value: Schema.Json | undefined) {
  return typeof value === "number" ? value : undefined;
}
export function classify(value: Schema.Json | undefined): AgentError["code"] {
  const source = JSON.stringify(value ?? null);
  if (/auth|unauthorized|invalid_api_key|401/iu.test(source)) {
    return "Authentication";
  }
  if (
    /rate_limit|usage_limit|overload|capacity|TooManyRequests|ServiceUnavailable|429|529/iu.test(
      source
    )
  ) {
    return "CapacityLimit";
  }
  if (/permission|denied|forbidden|403/iu.test(source)) {
    return "PermissionDenied";
  }
  return "ExecutionFailed";
}
const Event = Schema.Record(Schema.String, Schema.Json);
export function parseEvents(stdout: string) {
  return Effect.try({
    catch: () =>
      new AgentError({
        code: "ProtocolError",
        message: "Agent emitted malformed JSON events",
      }),
    try: () =>
      stdout
        .split(/\r?\n/u)
        .filter((line) => line.trim())
        .map((line) => Schema.decodeUnknownSync(Event)(JSON.parse(line))),
  });
}
function parseUsage(last: Record<string, Schema.Json>) {
  return Effect.gen(function* () {
    const raw = object(last.usage);
    const usage = yield* Schema.decodeUnknownEffect(Usage)({
      ...(number(raw.input_tokens) === undefined
        ? {}
        : { inputTokens: number(raw.input_tokens) }),
      ...(number(raw.output_tokens) === undefined
        ? {}
        : { outputTokens: number(raw.output_tokens) }),
      ...(number(raw.cached_input_tokens ?? raw.cache_read_input_tokens) ===
      undefined
        ? {}
        : {
            cachedInputTokens: number(
              raw.cached_input_tokens ?? raw.cache_read_input_tokens
            ),
          }),
      ...(number(raw.reasoning_output_tokens) === undefined
        ? {}
        : { reasoningOutputTokens: number(raw.reasoning_output_tokens) }),
      ...(number(last.total_cost_usd) === undefined
        ? {}
        : { costUsd: number(last.total_cost_usd) }),
    }).pipe(
      Effect.mapError(
        () =>
          new AgentError({
            code: "ProtocolError",
            message: "Agent reported invalid usage",
          })
      )
    );
    return usage;
  });
}
function terminalResult(
  kind: "claude" | "codex",
  events: readonly Record<string, Schema.Json>[],
  exitCode: number
) {
  return Effect.gen(function* () {
    const terminal = events.filter((event) =>
      kind === "claude"
        ? event.type === "result"
        : event.type === "turn.completed" || event.type === "turn.failed"
    );
    const last = terminal.at(-1);
    if (!last || terminal.length !== 1) {
      return yield* new AgentError({
        code: "ProtocolError",
        message: "Agent did not emit exactly one terminal result",
      });
    }
    if (
      exitCode !== 0 ||
      last.is_error === true ||
      last.type === "turn.failed" ||
      (kind === "claude" && last.subtype !== "success")
    ) {
      return yield* new AgentError({
        code:
          last.subtype === "error_max_structured_output_retries"
            ? "InvalidStructuredOutput"
            : classify(last),
        message: "Agent session failed",
      });
    }
    if (
      Array.isArray(last.permission_denials) &&
      last.permission_denials.length > 0
    ) {
      return yield* new AgentError({
        code: "PermissionDenied",
        message: "Agent session encountered denied permissions",
      });
    }
    return last;
  });
}
function finalOutput(
  kind: "claude" | "codex",
  last: Record<string, Schema.Json>,
  events: readonly Record<string, Schema.Json>[],
  structured: boolean
) {
  return Effect.gen(function* () {
    if (structured && kind === "claude") {
      if (last.structured_output === undefined) {
        return yield* new AgentError({
          code: "InvalidStructuredOutput",
          message: "Agent did not return structured output",
        });
      }
      return JSON.stringify(last.structured_output);
    }
    const finalMessage = events.findLast(
      (event) =>
        event.type === "item.completed" &&
        object(event.item).type === "agent_message"
    );
    const output =
      kind === "claude"
        ? text(last.result)
        : text(object(finalMessage?.item).text);
    if (output === undefined) {
      return yield* new AgentError({
        code: "ProtocolError",
        message: "Agent terminal result has no final response",
      });
    }
    return output;
  });
}
export function parseOutput(
  kind: "claude" | "codex",
  stdout: string,
  exitCode: number,
  stderr = "",
  structured = false
) {
  return Effect.gen(function* () {
    const diagnostic = classify(stderr);
    if (exitCode !== 0 && diagnostic !== "ExecutionFailed") {
      return yield* new AgentError({
        code: diagnostic,
        message: "Agent process failed",
      });
    }
    const events = yield* structured && kind === "claude"
      ? Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(stdout).pipe(
          Effect.flatMap((value) =>
            Schema.decodeEffect(Schema.Array(Event))(
              Array.isArray(value) ? value : [value]
            )
          ),
          Effect.mapError(
            () =>
              new AgentError({
                code: "ProtocolError",
                message: "Agent emitted malformed JSON result",
              })
          )
        )
      : parseEvents(stdout);
    const last = yield* terminalResult(kind, events, exitCode);
    const output = yield* finalOutput(kind, last, events, structured);
    const sessionId =
      kind === "claude"
        ? text(last.session_id)
        : text(
            events.find((event) => event.type === "thread.started")?.thread_id
          );
    const usage = yield* parseUsage(last);
    return {
      output,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(Object.keys(usage).length === 0 ? {} : { usage }),
      transcript: events,
    };
  });
}
const ClaudeOptions = Schema.Struct({
  effort: Schema.optionalKey(
    Schema.Literals(["low", "medium", "high", "xhigh", "max"])
  ),
});
const CodexOptions = Schema.Struct({
  reasoningEffort: Schema.optionalKey(
    Schema.Literals(["low", "medium", "high", "xhigh", "max"])
  ),
});
export function argumentsFor(
  kind: "claude" | "codex",
  request: AdapterRequest,
  schemaPath?: string
) {
  return Effect.gen(function* () {
    const { input, policy } = request;
    const options = input.options ?? {};
    const allowed = kind === "claude" ? ["effort"] : ["reasoningEffort"];
    if (Object.keys(options).some((key) => !allowed.includes(key))) {
      return yield* new AgentError({
        code: "UnsupportedOption",
        message: "Unsupported agent option",
      });
    }
    if (kind === "claude") {
      const native = policy.claude;
      if (!native) {
        return yield* new AgentError({
          code: "InvalidConfiguration",
          message: "Policy has no Claude configuration",
        });
      }
      const decoded = yield* Schema.decodeEffect(ClaudeOptions)(options).pipe(
        Effect.mapError(
          () =>
            new AgentError({
              code: "UnsupportedOption",
              message: "Invalid Claude options",
            })
        )
      );
      return [
        "-p",
        "--output-format",
        request.outputSchema === undefined ? "stream-json" : "json",
        ...(request.outputSchema === undefined ? ["--verbose"] : []),
        ...(request.outputSchema === undefined
          ? []
          : ["--json-schema", JSON.stringify(request.outputSchema)]),
        "--permission-mode",
        "default",
        "--permission-prompts",
        "none",
        "--tools",
        native.allowedTools.join(","),
        "--allowedTools",
        native.allowedTools.join(","),
        "--disallowedTools",
        native.disallowedTools.join(","),
        ...(input.model === undefined ? [] : ["--model", input.model]),
        ...(decoded.effort ? ["--effort", decoded.effort] : []),
        ...(input.resume ? ["--resume", input.resume.sessionId] : []),
      ];
    }
    const native = policy.codex;
    if (!native) {
      return yield* new AgentError({
        code: "InvalidConfiguration",
        message: "Policy has no Codex configuration",
      });
    }
    const decoded = yield* Schema.decodeEffect(CodexOptions)(options).pipe(
      Effect.mapError(
        () =>
          new AgentError({
            code: "UnsupportedOption",
            message: "Invalid Codex options",
          })
      )
    );
    if (request.outputSchema !== undefined && schemaPath === undefined) {
      return yield* new AgentError({
        code: "InvalidConfiguration",
        message: "Codex structured output requires a schema file",
      });
    }
    return [
      "-a",
      "never",
      "-c",
      `sandbox_mode=${JSON.stringify(native.sandbox)}`,
      "exec",
      ...(input.resume ? ["resume", input.resume.sessionId] : []),
      "--json",
      ...(schemaPath === undefined ? [] : ["--output-schema", schemaPath]),
      ...(input.model === undefined ? [] : ["--model", input.model]),
      ...(decoded.reasoningEffort
        ? [
            "-c",
            `model_reasoning_effort=${JSON.stringify(decoded.reasoningEffort)}`,
          ]
        : []),
      "-",
    ];
  });
}
export function cliAdapter(
  config: Platform<never, AgentError>,
  spawner: Spawner,
  fs: typeof FileSystem.Service,
  maximum: number
): Adapter {
  return {
    configuration: config.configuration,
    run: (request) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (config.kind === "opencode") {
            return yield* new AgentError({
              code: "InvalidConfiguration",
              message: "Expected a CLI platform",
            });
          }
          let schemaPath: string | undefined;
          if (request.outputSchema !== undefined && config.kind === "codex") {
            const directory = yield* fs
              .makeTempDirectoryScoped({ prefix: "effectory-agent-output-" })
              .pipe(
                Effect.mapError(
                  () =>
                    new AgentError({
                      code: "InvalidConfiguration",
                      message: "Could not create agent schema directory",
                    })
                )
              );
            schemaPath = path.join(directory, "output-schema.json");
            yield* fs
              .writeFileString(
                schemaPath,
                JSON.stringify(request.outputSchema),
                { mode: 0o600 }
              )
              .pipe(
                Effect.mapError(
                  () =>
                    new AgentError({
                      code: "InvalidConfiguration",
                      message: "Could not write agent output schema",
                    })
                )
              );
          }
          const args = yield* argumentsFor(config.kind, request, schemaPath);
          const environment = yield* config.environment;
          const version = yield* command(
            spawner,
            config.executable,
            ["--version"],
            request.input.workingDirectory,
            environment,
            4096
          ).pipe(
            Effect.timeoutOrElse({
              duration: "10 seconds",
              orElse: () =>
                Effect.fail(
                  new AgentError({
                    code: "Timeout",
                    message: "Agent version check timed out",
                  })
                ),
            })
          );
          if (
            version.exitCode !== 0 ||
            !version.stdout.split(/\s+/u).includes(config.version)
          ) {
            return yield* new AgentError({
              code: "InvalidConfiguration",
              message: "Agent binary version does not match configured version",
            });
          }
          yield* request.progress("Agent session started");
          const result = yield* command(
            spawner,
            config.executable,
            args,
            request.input.workingDirectory,
            environment,
            maximum,
            request.input.prompt
          );
          const parsed = yield* parseOutput(
            config.kind,
            result.stdout,
            result.exitCode,
            result.stderr,
            request.outputSchema !== undefined
          );
          return { ...parsed, version: config.version };
        })
      ),
    supportsResume: true,
    supportsStructuredOutput: true,
  };
}

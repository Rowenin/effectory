/* oxlint-disable promise/prefer-await-to-callbacks -- Effect error mapping, not Promise callbacks. */
import * as OpenCode from "@distilled.cloud/opencode";
import * as Retry from "@distilled.cloud/opencode/Retry";
import { Deferred, Effect, Layer, Redacted, Schema, Stream } from "effect";
import { FetchHttpClient, HttpIncomingMessage } from "effect/http";

import { classify } from "./cli.ts";
import { AgentError } from "./contracts.ts";
import type { Adapter, AdapterRequest, Platform } from "./options.ts";
import { bounded, spawn } from "./process.ts";
import type { Spawner } from "./process.ts";

const NativeOptions = Schema.Struct({
  agent: Schema.optionalKey(Schema.NonEmptyString),
  variant: Schema.optionalKey(Schema.NonEmptyString),
});
function validateRequest(request: AdapterRequest) {
  return Effect.gen(function* () {
    const permission = request.policy.opencode;
    const options = request.input.options ?? {};
    if (
      !permission ||
      Object.keys(options).some((key) => key !== "agent" && key !== "variant")
    ) {
      return yield* new AgentError({
        code: "UnsupportedOption",
        message: "Missing OpenCode policy or unsupported options",
      });
    }
    const native = yield* Schema.decodeEffect(NativeOptions)(options).pipe(
      Effect.mapError(
        () =>
          new AgentError({
            code: "UnsupportedOption",
            message: "Invalid OpenCode options",
          })
      )
    );
    const { model } = request.input;
    const separator = model?.indexOf("/") ?? -1;
    if (
      model !== undefined &&
      (separator < 1 || separator === model.length - 1)
    ) {
      return yield* new AgentError({
        code: "UnsupportedOption",
        message: "OpenCode models must use provider/model",
      });
    }
    return { model, native, permission, separator };
  });
}
function execute(request: AdapterRequest, version: string) {
  return Effect.gen(function* () {
    const { permission, native, model, separator } =
      yield* validateRequest(request);
    const health = yield* OpenCode.globalHealth({});
    if (!health.healthy || health.version !== version) {
      return yield* new AgentError({
        code: "InvalidConfiguration",
        message: "OpenCode server version does not match configured version",
      });
    }
    const directory = request.input.workingDirectory;
    const rules = [
      { action: "deny", pattern: "*", permission: "*" },
      ...permission,
    ];
    const session = yield* request.input.resume
      ? OpenCode.getSession({
          directory,
          sessionID: request.input.resume.sessionId,
        })
      : OpenCode.createSession({ directory, permission: rules });
    if (session.directory !== directory) {
      return yield* new AgentError({
        code: "InvalidConfiguration",
        message: "OpenCode session belongs to another working directory",
      });
    }
    yield* OpenCode.updateSession({
      directory,
      permission: rules,
      sessionID: session.id,
    });
    yield* request.progress("Agent session started");
    const result = yield* OpenCode.sessionPrompt({
      directory,
      parts: [{ text: request.input.prompt, type: "text" }],
      sessionID: session.id,
      ...(request.outputSchema === undefined
        ? {}
        : {
            format: {
              retryCount: 0,
              schema: request.outputSchema,
              type: "json_schema" as const,
            },
          }),
      ...(model === undefined
        ? {}
        : {
            model: {
              modelID: model.slice(separator + 1),
              providerID: model.slice(0, separator),
            },
          }),
      ...native,
    }).pipe(
      Effect.onExit(() =>
        OpenCode.abortSession({ directory, sessionID: session.id }).pipe(
          Effect.timeoutOption("2 seconds"),
          Effect.ignore
        )
      )
    );
    if (result.info.error?.name === "StructuredOutputError") {
      return yield* new AgentError({
        code: "InvalidStructuredOutput",
        message: "OpenCode did not produce the requested structured output",
      });
    }
    if (result.info.error) {
      return yield* new AgentError({
        code: classify({
          name: result.info.error.name,
          statusCode:
            result.info.error.name === "APIError"
              ? (result.info.error.data.statusCode ?? null)
              : null,
        }),
        message: "OpenCode session failed",
      });
    }
    if (
      result.info.role !== "assistant" ||
      result.info.time.completed === undefined ||
      result.info.finish === undefined ||
      result.info.finish === "tool-calls"
    ) {
      return yield* new AgentError({
        code: "ProtocolError",
        message: "OpenCode returned an incomplete response",
      });
    }
    const usage = {
      cachedInputTokens: result.info.tokens.cache.read,
      costUsd: result.info.cost,
      inputTokens: result.info.tokens.input,
      outputTokens: result.info.tokens.output,
      reasoningOutputTokens: result.info.tokens.reasoning,
    };
    const text = result.parts
      .flatMap((part) =>
        part.type === "text" && part.ignored !== true ? [part.text] : []
      )
      .join("\n");
    const structured =
      request.outputSchema === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(Schema.Json)(
            result.info.structured
          ).pipe(
            Effect.mapError(
              () =>
                new AgentError({
                  code: "InvalidStructuredOutput",
                  message: "OpenCode did not return valid structured output",
                })
            )
          );
    const output =
      request.outputSchema === undefined ? text : JSON.stringify(structured);
    return {
      output,
      reportedModel: `${result.info.providerID}/${result.info.modelID}`,
      sessionId: session.id,
      transcript: [{ output, type: "result", usage }],
      usage,
      version,
    };
  }).pipe(
    Retry.none,
    Effect.mapError((error) =>
      error instanceof AgentError
        ? error
        : new AgentError({
            code:
              error._tag === "OpencodeParseError"
                ? "ProtocolError"
                : classify(error._tag),
            message: "OpenCode operation failed",
          })
    )
  );
}

/** Each invocation owns a private authenticated server, including its process group. */
export function opencodeAdapter(
  config: Platform<never, AgentError>,
  spawner: Spawner,
  maximum: number
): Adapter {
  return {
    configuration: config.configuration,
    run: (request) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* validateRequest(request);
          const environment = yield* config.environment;
          const password = Redacted.make(crypto.randomUUID());
          const child = yield* spawn(
            spawner,
            config.executable,
            ["serve", "--hostname", "127.0.0.1", "--port", "0"],
            request.input.workingDirectory,
            {
              ...environment,
              OPENCODE_SERVER_PASSWORD: password,
              OPENCODE_SERVER_USERNAME: "opencode",
            }
          );
          const address = yield* Deferred.make<string>();
          let bytes = 0;
          const stdout = Stream.runForEach(
            child.stdout.pipe(
              Stream.mapEffect((chunk) =>
                Effect.suspend(() => {
                  bytes += chunk.byteLength;
                  return bytes > maximum
                    ? Effect.fail(
                        new AgentError({
                          code: "OutputLimit",
                          message:
                            "OpenCode server output exceeded its byte limit",
                        })
                      )
                    : Effect.succeed(chunk);
                })
              ),
              Stream.decodeText(),
              Stream.splitLines
            ),
            (line) =>
              Effect.gen(function* () {
                const match =
                  /opencode server listening on (?<address>http:\/\/127\.0\.0\.1:\d+)/u.exec(
                    line
                  );
                if (match?.groups?.address !== undefined) {
                  yield* Deferred.succeed(address, match.groups.address);
                }
              })
          );
          const monitor = Effect.all(
            [stdout, bounded(child.stderr, 65_536), child.exitCode],
            { concurrency: "unbounded" }
          ).pipe(
            Effect.andThen(
              Effect.fail(
                new AgentError({
                  code: "ExecutionFailed",
                  message:
                    "OpenCode server stopped before the session completed",
                })
              )
            )
          );
          const operation = Effect.gen(function* () {
            const baseUrl = yield* Deferred.await(address).pipe(
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () =>
                  Effect.fail(
                    new AgentError({
                      code: "Timeout",
                      message: "OpenCode server startup timed out",
                    })
                  ),
              })
            );
            return yield* execute(request, config.version).pipe(
              Effect.provide(
                Layer.merge(
                  FetchHttpClient.layer,
                  OpenCode.fromPassword({ apiBaseUrl: baseUrl, password })
                )
              ),
              Effect.provideService(
                HttpIncomingMessage.MaxBodySize,
                BigInt(maximum)
              )
            );
          });
          return yield* Effect.raceFirst(operation, monitor);
        })
      ).pipe(
        Effect.mapError((error) =>
          error instanceof AgentError
            ? error
            : new AgentError({
                code: "ExecutionFailed",
                message: "OpenCode server failed",
              })
        )
      ),
    supportsResume: true,
    supportsStructuredOutput: true,
  };
}

import { DefinitionError } from "@offtree/effectory-sdk";
import { Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { cliAdapter } from "./cli.ts";
import { AgentError, AgentRunner, SessionResult } from "./contracts.ts";
import { opencodeAdapter } from "./opencode.ts";
import type { Adapter, Options } from "./options.ts";

export function layer<R = never, E = never>(options: Options<R, E>) {
  return Layer.effect(
    AgentRunner,
    Effect.gen(function* () {
      const dependencies = yield* Effect.context<R>();
      const spawner = yield* ChildProcessSpawner;
      const fs = yield* FileSystem;
      const timeout = options.timeoutMillis ?? 900_000;
      const maximum = options.maximumOutputBytes ?? 524_288;
      if (
        !Number.isSafeInteger(timeout) ||
        timeout < 1 ||
        !Number.isSafeInteger(maximum) ||
        maximum < 1 ||
        maximum > 524_288
      ) {
        return yield* new DefinitionError({
          message: "Invalid agent runner limits",
        });
      }
      const policies = new Map(
        Object.entries(structuredClone(options.policies))
      );
      const adapters = new Map<string, Adapter>(
        Object.entries(options.adapters ?? {})
      );
      for (const [name, source] of Object.entries(options.platforms ?? {})) {
        if (
          adapters.has(name) ||
          !source.configuration ||
          !source.executable ||
          !source.version
        ) {
          return yield* new DefinitionError({
            message: "Invalid or duplicate agent platform",
          });
        }
        const config = {
          ...source,
          environment: source.environment.pipe(
            Effect.mapError(
              () =>
                new AgentError({
                  code: "Authentication",
                  message: "Agent credentials could not be resolved",
                })
            ),
            Effect.provideContext(dependencies)
          ),
        };
        adapters.set(
          name,
          config.kind === "opencode"
            ? opencodeAdapter(config, spawner, maximum)
            : cliAdapter(config, spawner, fs, maximum)
        );
      }
      const busy = new Set<string>();
      return AgentRunner.of({
        run: (input, progress, outputSchema) =>
          Effect.gen(function* () {
            const adapter = adapters.get(input.platform);
            const policy = policies.get(input.policy);
            if (!adapter || !policy) {
              return yield* new AgentError({
                code: "InvalidConfiguration",
                message: "Unknown agent platform or policy",
              });
            }
            if (
              outputSchema !== undefined &&
              adapter.supportsStructuredOutput !== true
            ) {
              return yield* new AgentError({
                code: "UnsupportedOption",
                message: "Agent platform does not support structured output",
              });
            }
            const directory = yield* fs.realPath(input.workingDirectory).pipe(
              Effect.mapError(
                () =>
                  new AgentError({
                    code: "InvalidConfiguration",
                    message: "Agent working directory does not exist",
                  })
              )
            );
            const info = yield* fs.stat(directory).pipe(
              Effect.mapError(
                () =>
                  new AgentError({
                    code: "InvalidConfiguration",
                    message: "Agent working directory is unavailable",
                  })
              )
            );
            if (info.type !== "Directory") {
              return yield* new AgentError({
                code: "InvalidConfiguration",
                message: "Agent working directory must be a directory",
              });
            }
            const { resume } = input;
            if (
              resume &&
              (!adapter.supportsResume ||
                resume.platform !== input.platform ||
                resume.configuration !== adapter.configuration ||
                resume.policy !== input.policy ||
                resume.workingDirectory !== directory)
            ) {
              return yield* new AgentError({
                code: "InvalidConfiguration",
                message:
                  "Session reference does not match this execution configuration",
              });
            }
            // Serialize workspace writers as well as session continuations within this runner.
            const key = directory;
            return yield* Effect.acquireUseRelease(
              Effect.suspend(() => {
                if (busy.has(key)) {
                  return Effect.fail(
                    new AgentError({
                      code: "SessionBusy",
                      message: "Agent working directory is already in use",
                    })
                  );
                }
                busy.add(key);
                return Effect.void;
              }),
              () =>
                Effect.gen(function* () {
                  const value = yield* adapter
                    .run({
                      input: { ...input, workingDirectory: directory },
                      policy,
                      progress,
                      ...(outputSchema === undefined
                        ? {}
                        : { outputSchema: structuredClone(outputSchema) }),
                    })
                    .pipe(
                      Effect.timeoutOrElse({
                        duration: timeout,
                        orElse: () =>
                          Effect.fail(
                            new AgentError({
                              code: "Timeout",
                              message: "Agent session timed out",
                            })
                          ),
                      })
                    );
                  if (
                    Buffer.byteLength(JSON.stringify(value.transcript)) >
                      maximum ||
                    Buffer.byteLength(value.output) > 131_072
                  ) {
                    return yield* new AgentError({
                      code: "OutputLimit",
                      message: "Agent result exceeded its byte limit",
                    });
                  }
                  const result = yield* Schema.decodeEffect(SessionResult)({
                    output: value.output,
                    platform: input.platform,
                    version: value.version,
                    workingDirectory: directory,
                    ...(input.model === undefined
                      ? {}
                      : { requestedModel: input.model }),
                    ...(value.reportedModel === undefined
                      ? {}
                      : { reportedModel: value.reportedModel }),
                    ...(value.usage === undefined
                      ? {}
                      : { usage: value.usage }),
                    ...(value.sessionId === undefined
                      ? {}
                      : {
                          session: {
                            configuration: adapter.configuration,
                            platform: input.platform,
                            policy: input.policy,
                            sessionId: value.sessionId,
                            workingDirectory: directory,
                          },
                        }),
                  }).pipe(
                    Effect.mapError(
                      () =>
                        new AgentError({
                          code: "ProtocolError",
                          message: "Agent returned an invalid result",
                        })
                    )
                  );
                  yield* progress("Agent session completed");
                  return {
                    result,
                    transcript:
                      input.retainTranscript === true ? value.transcript : [],
                  };
                }),
              () =>
                Effect.sync(() => {
                  busy.delete(key);
                })
            );
          }),
      });
    })
  );
}

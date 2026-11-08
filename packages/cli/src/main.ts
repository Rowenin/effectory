#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { repositorySnapshot } from "@effectory/platform-bun/backup";
import { connect } from "@effectory/platform-bun/client";
import { serve, Endpoint } from "@effectory/platform-bun/daemon";
import {
  parseSource,
  restoreExtensions,
} from "@effectory/platform-bun/extensions";
import {
  compiled,
  hostAbi,
  hostVersions,
  internalCommand,
  selfCommand,
} from "@effectory/platform-bun/host";
import { runInternalCommand } from "@effectory/platform-bun/internal";
import { reclaimRuns } from "@effectory/platform-bun/run-reclamation";
import {
  initProject,
  projectStatus,
  projectWarning,
  upgradeProject,
} from "@effectory/platform-bun/sdk";
import { runtimeUpgrade } from "@effectory/platform-bun/upgrade";
import { OperationListRequest } from "@effectory/runtime/extension-protocol";
import {
  WaitListRequest,
  LogListRequest,
} from "@effectory/runtime/history-protocol";
import { Query } from "@effectory/runtime/lake-protocol";
import {
  OperationError,
  terminal,
  RunStatus,
} from "@effectory/runtime/protocol";
import { ScheduleListRequest } from "@effectory/runtime/schedule-protocol";
import { checkJsonBudget } from "@offtree/effectory-sdk/internal/boundary";
import { Cause, Console, Effect, Exit, Option, Schema, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { RpcClientError } from "effect/rpc";

import { createWatchClient } from "../../platform-bun/src/watch-client.ts";
import cliPackage from "../package.json" with { type: "json" };
import { agentMutation, agentStatus } from "./agent-files.ts";
import { checksPreflight, checkLaunch, checkDestination } from "./checks.ts";
import { download } from "./download.ts";
import { writeJsonLine } from "./json-lines.ts";
import { exportJUnit } from "./junit.ts";
import { consumeObservation, stopForeground } from "./observation.ts";
import { createProgress } from "./progress.ts";
import {
  automaticRetentionFor,
  parseReclamation,
  retentionFor,
} from "./reclamation.ts";
import {
  recoveryRequest,
  recoveryRetry,
  recoveryGuidance,
} from "./recovery.ts";
import {
  searchPreflight,
  searchRequest,
  searchContinuation,
} from "./report-search.ts";
import { selectionFlags, selectionFor } from "./report-selection.ts";
import {
  reportExit,
  reportsPreflight,
  runOrigin,
  reportText,
  waitReport,
  waitReports,
} from "./reports.ts";
import { tagsFor } from "./tags.ts";
import { offlineVault, readSecret, writeSecret } from "./vault-io.ts";

const root = Command.make("effectory").pipe(
  Command.withSharedFlags({
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Compact JSON output; suppress human progress")
    ),
    repository: Flag.String("repository").pipe(Flag.withDefault(process.cwd())),
  })
);
type Client = Effect.Success<ReturnType<typeof connect>>;
let exitCode = 0;
const inputFlags = {
  input: Flag.String("input").pipe(Flag.optional),
  inputFile: Flag.String("input-file").pipe(Flag.optional),
};
const idFlag = Argument.String("id");
const requestKeyFlag = Flag.String("request-key").pipe(Flag.optional);
const revisionFlag = Flag.String("revision").pipe(Flag.optional);
const tagFlag = Flag.String("tag").pipe(
  Flag.atMost(32),
  Flag.withDescription("Run metadata as KEY=VALUE (repeatable)")
);
const pageFlags = {
  cursor: Flag.String("cursor").pipe(Flag.optional),
  limit: Flag.Int("limit").pipe(Flag.withDefault(50)),
};
const page = (config: {
  readonly limit: number;
  readonly cursor: Option.Option<string>;
}) => ({
  limit: config.limit,
  ...(Option.isSome(config.cursor) ? { cursor: config.cursor.value } : {}),
});
const optionalText = <K extends string>(
  key: K,
  value: Option.Option<string>
) => (Option.isSome(value) ? { [key]: value.value } : {});
const revision = (value: Option.Option<string>) =>
  Option.isSome(value) ? { revision: value.value } : {};
const print = (value: unknown) =>
  Effect.gen(function* () {
    const config = yield* root;
    yield* Console.log(
      JSON.stringify(value, null, config.json ? undefined : 2)
    );
  });
const withClient = <A, E, R>(
  body: (client: Client) => Effect.Effect<A, E, R>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* root;
      const client = yield* connect(path.resolve(config.repository));
      return yield* body(client);
    })
  );
function parseInput(input: Option.Option<string>, file: Option.Option<string>) {
  return Effect.tryPromise({
    catch: () =>
      new OperationError({
        code: "InvalidInput",
        message: "Expected JSON input of at most 1 MiB from one input source",
      }),
    try: async () => {
      if (Option.isSome(input) && Option.isSome(file)) {
        throw new Error("Use one input source");
      }
      let text = Option.getOrElse(input, () => "{}");
      if (Option.isSome(file)) {
        if (file.value === "-") {
          const reader = Bun.stdin.stream().getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              // oxlint-disable-next-line no-await-in-loop -- Stream reads depend on the preceding chunk.
              const chunk = await reader.read();
              if (chunk.done) {
                break;
              }
              size += chunk.value.length;
              if (size > 1_048_576) {
                throw new Error("Input limit exceeded");
              }
              chunks.push(chunk.value);
            }
            text = Buffer.concat(chunks).toString();
          } finally {
            await reader.cancel();
          }
        } else {
          const source = Bun.file(file.value);
          if (source.size > 1_048_576) {
            throw new Error("Input limit exceeded");
          }
          text = await source.text();
        }
      }
      if (Buffer.byteLength(text) > 1_048_576) {
        throw new Error("Input limit exceeded");
      }
      const parsed: unknown = JSON.parse(text);
      checkJsonBudget(parsed);
      return Schema.decodeUnknownSync(Schema.Json)(parsed);
    },
  });
}

type WatchClient = Effect.Success<ReturnType<typeof createWatchClient>>;

function observationHint(
  runId: string,
  accepted: boolean,
  after?: number,
  cursorKind = "written"
) {
  return (error: unknown) => {
    let recovery = ` Resume run watch ${runId} --jsonl --after-sequence ${after ?? 0}.`;
    if (error instanceof OperationError && error.code === "LimitExceeded") {
      recovery =
        after === undefined ? "" : ` Last event ${cursorKind}: ${after}.`;
    }
    return Console.error(
      `${accepted ? `Run ${runId} was accepted. ` : ""}Inspect with run get ${runId}.${recovery}`
    ).pipe(Effect.catchCause(() => Effect.void));
  };
}

function watchPreflight(client: Client, submission: boolean, runId?: string) {
  return Effect.gen(function* () {
    const config = yield* root;
    const status = yield* client.SystemStatus({});
    const watch = yield* createWatchClient(
      path.resolve(config.repository),
      status
    ).pipe(
      Effect.mapError((error) =>
        error instanceof OperationError && error.code === "Unavailable"
          ? new OperationError({
              code: error.code,
              message: `${error.message} ${submission ? "To submit without observing, use --background." : `Inspect with run get ${runId}.`}`,
            })
          : error
      )
    );
    return { status, watch };
  });
}

function observe(
  client: Client,
  watch: WatchClient,
  runId: string,
  untilWaiting: boolean,
  afterSequence = 0,
  junit?: { readonly output?: string }
) {
  return Effect.gen(function* () {
    const config = yield* root;
    const progress = createProgress(!config.json, afterSequence);
    return yield* Effect.gen(function* () {
      yield* watch.RunWatch({ afterSequence, runId }).pipe(
        Stream.takeUntilEffect((frame) =>
          progress.process(frame, (snapshot) =>
            untilWaiting
              ? stopForeground(snapshot, () =>
                  client
                    .WaitList({ limit: 1, runId, status: "Open" })
                    .pipe(Effect.map((waits) => waits.items.length > 0))
                )
              : Effect.succeed(terminal.has(snapshot.run.status))
          )
        ),
        Stream.runDrain,
        consumeObservation
      );
      const run = yield* client.RunGet({ runId });
      if (junit === undefined) {
        yield* print(run);
      } else if (terminal.has(run.status)) {
        yield* exportJUnit(client, run, junit.output);
      } else {
        yield* Console.error(
          `Run ${runId} was accepted. Export after completion with effectory run junit ${runId}.`
        ).pipe(Effect.ignoreCause);
      }
      exitCode = terminal.has(run.status) ? 1 : 4;
      if (run.status === "Succeeded") {
        exitCode = 0;
      }
      if (exitCode === 4) {
        const supportsRecovery = yield* client.SystemStatus({}).pipe(
          Effect.map((status) =>
            status.capabilities.includes("run.recovery.v1")
          ),
          Effect.catch(() => Effect.succeed(false))
        );
        yield* Console.error(
          `Outside action is available or the run needs attention. Inspect run waits ${runId} and run get ${runId}.${supportsRecovery && run.status === "NeedsAttention" ? ` Assess uncertain tasks with run recover ${runId}.` : ""}`
        ).pipe(Effect.catchCause(() => Effect.void));
      }
    }).pipe(
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Effect callback, not a Promise.
      Effect.tapError((error) =>
        observationHint(
          runId,
          untilWaiting,
          progress.cursor,
          config.json ? "consumed" : "displayed"
        )(error)
      )
    );
  });
}
function observeJsonLines(
  client: Client,
  watch: WatchClient,
  runId: string,
  afterSequence: number
) {
  return Effect.suspend(() => {
    let after = afterSequence;
    return Effect.gen(function* () {
      yield* watch.RunWatch({ afterSequence, runId }).pipe(
        Stream.runForEach((frame) =>
          writeJsonLine(frame).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (frame._tag === "Event") {
                  after = frame.event.sequence;
                }
              })
            )
          )
        ),
        consumeObservation
      );
      const run = yield* client.RunGet({ runId });
      exitCode = run.status === "Succeeded" ? 0 : 1;
    }).pipe(
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Effect callback, not a Promise.
      Effect.tapError((error) => observationHint(runId, false, after)(error))
    );
  });
}

function waitDecision<A, E, R>(
  operation: string,
  waitId: string,
  requestedKey: Option.Option<string>,
  send: (requestKey: string) => Effect.Effect<A, E, R>
) {
  return Effect.suspend(() => {
    const requestKey = Option.getOrElse(requestedKey, () =>
      crypto.randomUUID()
    );
    return send(requestKey).pipe(
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This builds an Effect; it is not a Promise callback.
      Effect.tapError((error) =>
        error instanceof OperationError
          ? Effect.void
          : Console.error(
              `Delivery uncertain. Retry run ${operation} ${waitId} with the same payload and --request-key ${requestKey}`
            )
      ),
      Effect.flatMap(print)
    );
  });
}

function definitions(kind: "task" | "workflow") {
  const list = Command.make(
    "list",
    {
      ...pageFlags,
      namespace: Flag.String("namespace").pipe(Flag.optional),
      revision: revisionFlag,
      search: Flag.String("search").pipe(Flag.optional),
    },
    (config) =>
      withClient((client) =>
        client[kind === "task" ? "TaskList" : "WorkflowList"]({
          ...page(config),
          ...revision(config.revision),
          ...optionalText("search", config.search),
          ...optionalText("namespace", config.namespace),
        }).pipe(Effect.flatMap(print))
      )
  );
  const describe = Command.make(
    "describe",
    { id: idFlag, revision: revisionFlag },
    (config) =>
      withClient((client) =>
        client[kind === "task" ? "TaskDescribe" : "WorkflowDescribe"]({
          id: config.id,
          ...revision(config.revision),
        }).pipe(Effect.flatMap(print))
      )
  );
  const validate = Command.make(
    "validate",
    { ...inputFlags, id: idFlag, revision: revisionFlag },
    (config) =>
      withClient((client) =>
        Effect.gen(function* () {
          const input = yield* parseInput(config.input, config.inputFile);
          const result = yield* client[
            kind === "task" ? "TaskValidate" : "WorkflowValidate"
          ]({ id: config.id, input, ...revision(config.revision) });
          if (!result.valid) {
            exitCode = 2;
          }
          yield* print(result);
        })
      )
  );
  const run = Command.make(
    "run",
    {
      ...inputFlags,
      ...selectionFlags,
      background: Flag.Boolean("background").pipe(Flag.withDefault(false)),
      failOn: Flag.Literals("fail-on", ["low", "medium", "high"]).pipe(
        Flag.optional
      ),
      id: idFlag,
      junit: Flag.Boolean("junit").pipe(Flag.withDefault(false)),
      output: Flag.String("output").pipe(Flag.optional),
      requestKey: requestKeyFlag,
      revision: revisionFlag,
      tags: tagFlag,
    },
    (config) =>
      withClient((client) =>
        Effect.gen(function* () {
          const globalConfig = yield* root;
          yield* checkLaunch(config, globalConfig.json);
          const input = yield* parseInput(config.input, config.inputFile);
          const observation = config.background
            ? undefined
            : yield* watchPreflight(client, true);
          if (config.junit || Option.isSome(config.failOn)) {
            yield* checksPreflight(
              observation === undefined
                ? client
                : { SystemStatus: () => Effect.succeed(observation.status) }
            );
          }
          const selectionPayload = yield* selectionFor(
            observation === undefined
              ? client
              : { SystemStatus: () => Effect.succeed(observation.status) },
            config
          );
          const tagPayload = yield* tagsFor(
            observation === undefined
              ? client
              : { SystemStatus: () => Effect.succeed(observation.status) },
            config.tags
          );
          const requestKey = Option.getOrElse(config.requestKey, () =>
            crypto.randomUUID()
          );
          const result = yield* client[
            kind === "task" ? "TaskRun" : "WorkflowRun"
          ]({
            id: config.id,
            input,
            requestKey,
            ...tagPayload,
            ...(Option.isSome(config.failOn)
              ? { checks: { failOn: config.failOn.value } }
              : {}),
            ...selectionPayload,
            ...revision(config.revision),
          }).pipe(
            Effect.tapError((failure) =>
              failure instanceof OperationError
                ? Effect.void
                : Console.error(
                    `Submission delivery is uncertain. Retry with --request-key ${requestKey}`
                  )
            )
          );
          if (config.background) {
            yield* print(result);
            return;
          }
          if (observation) {
            const global = yield* root;
            if (
              !global.json &&
              observation.status.capabilities.includes("reports.v1")
            ) {
              yield* client[
                kind === "task" ? "TaskDescribe" : "WorkflowDescribe"
              ]({ id: result.targetId, revision: result.revision }).pipe(
                Effect.flatMap((description) =>
                  typeof description === "object" &&
                  description !== null &&
                  "reports" in description &&
                  Array.isArray(description.reports) &&
                  description.reports.length > 0
                    ? Console.error(
                        `Reports: effectory report list ${result.runId}${result.reportSelection?.required.length ? " (required reports remain selected)" : ""}`
                      )
                    : Effect.void
                ),
                Effect.catchCause(() => Effect.void)
              );
            }
            yield* observe(
              client,
              observation.watch,
              result.runId,
              true,
              0,
              config.junit
                ? { ...optionalText("output", config.output) }
                : undefined
            );
          }
        })
      )
  );
  const plan = Command.make(
    "plan",
    { ...inputFlags, id: idFlag, revision: revisionFlag },
    (config) =>
      withClient((client) =>
        Effect.gen(function* () {
          const input = yield* parseInput(config.input, config.inputFile);
          yield* client
            .WorkflowPlan({
              id: config.id,
              input,
              ...revision(config.revision),
            })
            .pipe(Effect.flatMap(print));
        })
      )
  );
  return Command.make(kind).pipe(
    Command.withSubcommands(
      kind === "task"
        ? [list, describe, validate, run]
        : [list, describe, validate, run, plan]
    )
  );
}

const reportCommands = Command.make("report").pipe(
  Command.withSubcommands([
    Command.make(
      "search",
      {
        ...pageFlags,
        attachmentId: Flag.String("attachment").pipe(Flag.optional),
        createdAfter: Flag.String("created-after").pipe(Flag.optional),
        createdBefore: Flag.String("created-before").pipe(Flag.optional),
        history: Flag.Boolean("history").pipe(Flag.withDefault(false)),
        query: Argument.String("query").pipe(Argument.optional),
        reporterId: Flag.String("reporter").pipe(Flag.optional),
        runId: Flag.String("run").pipe(Flag.optional),
        scope: Flag.String("scope").pipe(Flag.optional),
        sourceWorkflowId: Flag.String("source-workflow").pipe(Flag.optional),
        statuses: Flag.String("status").pipe(Flag.atMost(8)),
        tags: tagFlag,
        taskId: Flag.String("task").pipe(Flag.optional),
        workflowId: Flag.String("workflow").pipe(Flag.optional),
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            const global = yield* root;
            const request = yield* searchRequest(
              {
                ...page(config),
                history: config.history,
                ...optionalText("attachmentId", config.attachmentId),
                ...optionalText("createdAfter", config.createdAfter),
                ...optionalText("createdBefore", config.createdBefore),
                ...optionalText("query", config.query),
                ...optionalText("reporterId", config.reporterId),
                ...optionalText("runId", config.runId),
                ...optionalText("scope", config.scope),
                ...optionalText("taskId", config.taskId),
                ...optionalText("workflowId", config.workflowId),
                ...optionalText("sourceWorkflowId", config.sourceWorkflowId),
                ...(config.statuses.length
                  ? { statuses: [...new Set(config.statuses)] }
                  : {}),
              },
              config.tags
            );
            yield* searchPreflight(
              client,
              request.sourceWorkflowId !== undefined
            );
            const result = yield* client.ReportSearch(request);
            yield* print(result);
            if (!global.json) {
              let note: string | null = null;
              if (result.cursor === null) {
                if (result.items.length === 0) {
                  note =
                    "No further matches. ID filters are exact and case-sensitive.";
                }
              } else {
                note = `Continue report search:\n${searchContinuation(request, result.cursor, global.repository)}`;
              }
              if (note !== null) {
                yield* Effect.sync(() => console.error(note)).pipe(
                  Effect.catchCause(() => Effect.void)
                );
              }
            }
          })
        )
    ),
    Command.make(
      "list",
      {
        ...pageFlags,
        history: Flag.Boolean("history").pipe(Flag.withDefault(false)),
        id: idFlag,
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            yield* reportsPreflight(client);
            yield* client
              .RunReports({
                history: config.history,
                runId: config.id,
                ...page(config),
              })
              .pipe(Effect.flatMap(print));
          })
        )
    ),
    Command.make(
      "get",
      {
        data: Flag.Boolean("data").pipe(Flag.withDefault(false)),
        id: idFlag,
        output: Flag.String("output").pipe(Flag.optional),
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            const global = yield* root;
            if (global.json && (config.data || Option.isSome(config.output))) {
              return yield* new OperationError({
                code: "InvalidInput",
                message: "--json cannot be combined with --data or --output",
              });
            }
            yield* reportsPreflight(client);
            const reply = yield* client.ReportGet({ reportId: config.id });
            exitCode = reportExit(reply.record.status);
            if (global.json || reply.content === null) {
              yield* print(reply);
              return;
            }
            const text = config.data
              ? JSON.stringify(reply.content.data, null, 2)
              : reply.content.markdown;
            yield* reportText(text, Option.getOrUndefined(config.output));
          })
        )
    ),
    Command.make(
      "wait",
      {
        id: idFlag.pipe(Argument.optional),
        report: Flag.String("report").pipe(Flag.optional),
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            if (Option.isSome(config.id) === Option.isSome(config.report)) {
              return yield* new OperationError({
                code: "InvalidInput",
                message: "Choose a source run ID or --report REPORT_ID",
              });
            }
            yield* reportsPreflight(client);
            if (Option.isSome(config.report)) {
              const reply = yield* waitReport(client, config.report.value);
              exitCode = reportExit(reply.record.status);
              yield* print(reply);
            } else if (Option.isSome(config.id)) {
              const result = yield* waitReports(client, config.id.value);
              exitCode = result.code;
              yield* print(result.aggregate);
            }
          })
        )
    ),
    Command.make(
      "retry",
      { id: idFlag, requestKey: requestKeyFlag },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            yield* reportsPreflight(client);
            const key = Option.getOrElse(config.requestKey, () =>
              crypto.randomUUID()
            );
            yield* client
              .ReportRetry({ reportId: config.id, requestKey: key })
              .pipe(
                Effect.tapError((error) =>
                  error instanceof OperationError
                    ? Effect.void
                    : Console.error(
                        `Delivery uncertain. Retry effectory report retry ${config.id} --request-key ${key}`
                      ).pipe(Effect.catchCause(() => Effect.void))
                ),
                Effect.flatMap(print)
              );
          })
        )
    ),
    Command.make(
      "cancel",
      {
        id: idFlag.pipe(Argument.optional),
        reason: Flag.String("reason").pipe(Flag.optional),
        requestKey: requestKeyFlag,
        run: Flag.String("run").pipe(Flag.optional),
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            if (Option.isSome(config.id) === Option.isSome(config.run)) {
              return yield* new OperationError({
                code: "InvalidInput",
                message: "Choose a report ID or --run SOURCE_RUN_ID",
              });
            }
            yield* reportsPreflight(client);
            const key = Option.getOrElse(config.requestKey, () =>
              crypto.randomUUID()
            );
            const reason = Option.isSome(config.reason)
              ? { reason: config.reason.value }
              : {};
            const request = Option.isSome(config.run)
              ? { requestKey: key, sourceRunId: config.run.value, ...reason }
              : {
                  reportId: Option.getOrElse(config.id, () => ""),
                  requestKey: key,
                  ...reason,
                };
            yield* client.ReportCancel(request).pipe(
              Effect.tapError((error) =>
                error instanceof OperationError
                  ? Effect.void
                  : Console.error(
                      `Delivery uncertain. Retry report cancel with the same selection, reason and --request-key ${key}`
                    ).pipe(Effect.catchCause(() => Effect.void))
              ),
              Effect.flatMap(print)
            );
          })
        )
    ),
  ])
);

const runCommands = Command.make("run").pipe(
  Command.withSubcommands([
    Command.make("reclaim").pipe(
      Command.withSubcommands([
        Command.make(
          "plan",
          {
            completedBefore: Flag.String("completed-before").pipe(
              Flag.optional
            ),
            run: Flag.String("run").pipe(Flag.optional),
            target: Flag.String("target").pipe(Flag.optional),
          },
          (config) =>
            Effect.gen(function* () {
              const shared = yield* root;
              yield* reclaimRuns(shared.repository, {
                kind: "plan",
                selector: {
                  ...(Option.isSome(config.run)
                    ? { runId: config.run.value }
                    : {}),
                  ...(Option.isSome(config.completedBefore)
                    ? { completedBefore: config.completedBefore.value }
                    : {}),
                  ...(Option.isSome(config.target)
                    ? { target: config.target.value }
                    : {}),
                },
              }).pipe(Effect.flatMap(print));
            })
        ),
        Command.make("apply", { id: Argument.String("plan-id") }, (config) =>
          Effect.gen(function* () {
            const shared = yield* root;
            yield* reclaimRuns(shared.repository, {
              kind: "apply",
              planId: config.id,
            }).pipe(Effect.flatMap(print));
          })
        ),
        Command.make("inspect", { id: Argument.String("run-id") }, (config) =>
          Effect.gen(function* () {
            const shared = yield* root;
            yield* reclaimRuns(shared.repository, {
              kind: "inspect",
              runId: config.id,
            }).pipe(Effect.flatMap(print));
          })
        ),
        Command.make("compact", {}, () =>
          Effect.gen(function* () {
            const shared = yield* root;
            yield* reclaimRuns(shared.repository, { kind: "compact" }).pipe(
              Effect.flatMap(print)
            );
          })
        ),
      ])
    ),
    Command.make(
      "checks",
      {
        id: Argument.String("id"),
        ...pageFlags,
        attempts: Flag.Literals("attempts", ["latest", "all"]).pipe(
          Flag.withDefault("latest")
        ),
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            yield* checksPreflight(client);
            yield* client
              .RunChecks({
                attempts: config.attempts,
                runId: config.id,
                ...page(config),
              })
              .pipe(Effect.flatMap(print));
          })
        )
    ),
    Command.make(
      "junit",
      {
        id: Argument.String("id"),
        output: Flag.String("output").pipe(Flag.optional),
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            yield* checksPreflight(client);
            const output = Option.getOrUndefined(config.output);
            yield* checkDestination(output);
            const run = yield* client.RunGet({ runId: config.id });
            yield* exportJUnit(client, run, output);
            exitCode = run.status === "Succeeded" ? 0 : 1;
          })
        )
    ),
    Command.make(
      "list",
      {
        ...pageFlags,
        createdAfter: Flag.String("created-after").pipe(Flag.optional),
        createdBefore: Flag.String("created-before").pipe(Flag.optional),
        kind: Flag.String("kind").pipe(Flag.optional),
        origin: Flag.Literals("origin", [
          "manual",
          "schedule",
          "report",
          "all",
        ]).pipe(Flag.optional),
        status: Flag.String("status").pipe(Flag.optional),
        tags: tagFlag,
        targetId: Flag.String("target").pipe(Flag.optional),
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            const kind = Option.isSome(config.kind)
              ? yield* Schema.decodeUnknownEffect(
                  Schema.Literals(["task", "workflow"])
                )(config.kind.value)
              : null;
            if (Option.isSome(config.origin)) {
              yield* reportsPreflight(client);
            }
            const tagPayload = yield* tagsFor(client, config.tags);
            const status = Option.isSome(config.status)
              ? yield* Schema.decodeUnknownEffect(RunStatus)(
                  config.status.value
                )
              : null;
            yield* client
              .RunList({
                ...tagPayload,
                ...page(config),
                ...(Option.isSome(config.origin)
                  ? { origin: config.origin.value }
                  : {}),
                ...optionalText("targetId", config.targetId),
                ...optionalText("createdAfter", config.createdAfter),
                ...optionalText("createdBefore", config.createdBefore),
                ...(kind === null ? {} : { kind }),
                ...(status === null ? {} : { status }),
              })
              .pipe(
                Effect.map((result) => ({
                  ...result,
                  items: result.items.map((item) => ({
                    ...item,
                    origin: runOrigin(item),
                  })),
                })),
                Effect.flatMap(print)
              );
          })
        )
    ),

    Command.make(
      "recover",
      {
        acknowledge: Flag.Boolean("acknowledge-reexecution").pipe(
          Flag.withDefault(false)
        ),
        authorize: Flag.String("authorize").pipe(Flag.optional),
        cursor: Flag.String("cursor").pipe(Flag.optional),
        id: idFlag,
        limit: Flag.Int("limit").pipe(Flag.optional),
        reason: Flag.String("reason").pipe(Flag.optional),
        requestKey: requestKeyFlag,
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            const action = yield* recoveryRequest(config);
            const status = yield* client.SystemStatus({});
            if (!status.capabilities.includes("run.recovery.v1")) {
              return yield* new OperationError({
                code: "Unavailable",
                message:
                  "Daemon does not support recovery. Use the compatible recovery-capable host build; an arbitrary upgrade cannot load older pinned revisions.",
              });
            }
            if (action._tag === "Assess") {
              const assessment = yield* client.RunRecoveryGet(action.request);
              if (!(yield* root).json) {
                yield* Console.error(recoveryGuidance(assessment));
              }
              yield* print(assessment);
            } else {
              const receipt = yield* client
                .RunRecover(action.request)
                .pipe(
                  Effect.tapError((error) =>
                    error instanceof OperationError
                      ? Effect.void
                      : Console.error(recoveryRetry(action.request)).pipe(
                          Effect.catchCause(() => Effect.void)
                        )
                  )
                );
              yield* print(receipt);
            }
          })
        )
    ),

    Command.make(
      "cancel",
      {
        id: idFlag,
        reason: Flag.String("reason").pipe(Flag.optional),
        requestKey: requestKeyFlag,
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            const requestKey = Option.getOrElse(config.requestKey, () =>
              crypto.randomUUID()
            );
            const receipt = yield* client
              .RunCancel({
                requestKey,
                runId: config.id,
                ...(Option.isSome(config.reason)
                  ? { reason: config.reason.value }
                  : {}),
              })
              .pipe(
                Effect.tapError((error) =>
                  error instanceof OperationError
                    ? Effect.void
                    : Console.error(
                        `Cancellation delivery is uncertain. Retry with --request-key ${requestKey}`
                      )
                )
              );
            yield* print(receipt);
          })
        )
    ),

    Command.make("summary", { id: idFlag }, ({ id }) =>
      withClient((client) =>
        Effect.gen(function* () {
          const config = yield* root;
          yield* reportsPreflight(client);
          const summary = yield* client.RunSummarize({ runId: id });
          yield* config.json ? print(summary) : reportText(summary.markdown);
        })
      )
    ),
    Command.make("get", { id: idFlag }, ({ id }) =>
      withClient((client) =>
        client.RunGet({ runId: id }).pipe(Effect.flatMap(print))
      )
    ),
    Command.make(
      "outputs",
      {
        ...pageFlags,
        id: idFlag,
        nodeId: Flag.String("node-id").pipe(Flag.optional),
      },
      (config) =>
        withClient((client) =>
          client
            .RunOutputs({
              ...page(config),
              runId: config.id,
              ...optionalText("nodeId", config.nodeId),
            })
            .pipe(Effect.flatMap(print))
        )
    ),
    Command.make(
      "logs",
      {
        ...pageFlags,
        id: idFlag,
        level: Flag.String("level").pipe(Flag.optional),
        nodeId: Flag.String("node-id").pipe(Flag.optional),
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            const request = yield* Schema.decodeUnknownEffect(LogListRequest)({
              ...page(config),
              runId: config.id,
              ...optionalText("nodeId", config.nodeId),
              ...optionalText("level", config.level),
            });
            yield* client.RunLogs(request).pipe(Effect.flatMap(print));
          })
        )
    ),
    Command.make(
      "events",
      {
        ...pageFlags,
        after: Flag.Int("after-sequence").pipe(Flag.optional),
        id: idFlag,
      },
      (config) =>
        withClient((client) =>
          client
            .RunEvents({
              ...page(config),
              runId: config.id,
              ...(Option.isSome(config.after)
                ? { afterSequence: config.after.value }
                : {}),
            })
            .pipe(Effect.flatMap(print))
        )
    ),
    Command.make(
      "watch",
      {
        afterSequence: Flag.Int("after-sequence").pipe(Flag.withDefault(0)),
        id: idFlag,
        jsonl: Flag.Boolean("jsonl").pipe(Flag.withDefault(false)),
      },
      ({ id, jsonl, afterSequence }) =>
        withClient((client) =>
          Effect.gen(function* () {
            const { watch } = yield* watchPreflight(client, false, id);
            return yield* jsonl
              ? observeJsonLines(client, watch, id, afterSequence)
              : observe(client, watch, id, false, afterSequence);
          })
        )
    ),
    Command.make(
      "waits",
      {
        ...pageFlags,
        id: idFlag.pipe(Argument.optional),
        kind: Flag.String("kind").pipe(Flag.optional),
        status: Flag.String("status").pipe(Flag.optional),
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            const request = yield* Schema.decodeUnknownEffect(WaitListRequest)({
              ...page(config),
              ...optionalText("runId", config.id),
              ...optionalText("kind", config.kind),
              ...optionalText("status", config.status),
            });
            yield* client.WaitList(request).pipe(Effect.flatMap(print));
          })
        )
    ),
    Command.make("wait", { id: idFlag }, ({ id }) =>
      withClient((client) =>
        client.WaitGet({ waitId: id }).pipe(Effect.flatMap(print))
      )
    ),
    Command.make(
      "approve",
      { id: idFlag, requestKey: requestKeyFlag },
      ({ id, requestKey }) =>
        withClient((client) =>
          waitDecision("approve", id, requestKey, (key) =>
            client.WaitApprove({
              requestKey: key,
              waitId: id,
            })
          )
        )
    ),
    Command.make(
      "reject",
      {
        id: idFlag,
        reason: Flag.String("reason").pipe(Flag.optional),
        requestKey: requestKeyFlag,
      },
      ({ id, requestKey, reason }) =>
        withClient((client) =>
          waitDecision("reject", id, requestKey, (key) =>
            client.WaitReject({
              requestKey: key,
              waitId: id,
              ...(Option.isSome(reason) ? { reason: reason.value } : {}),
            })
          )
        )
    ),
    Command.make(
      "respond",
      { ...inputFlags, id: idFlag, requestKey: requestKeyFlag },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            const input = yield* parseInput(config.input, config.inputFile);
            yield* waitDecision(
              "respond",
              config.id,
              config.requestKey,
              (key) =>
                client.WaitRespond({
                  input,
                  requestKey: key,
                  waitId: config.id,
                })
            );
          })
        )
    ),
    Command.make(
      "signal",
      {
        id: idFlag,
        payload: Flag.String("payload").pipe(Flag.optional),
        payloadFile: Flag.String("payload-file").pipe(Flag.optional),
        requestKey: requestKeyFlag,
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            const payload = yield* parseInput(
              config.payload,
              config.payloadFile
            );
            yield* waitDecision("signal", config.id, config.requestKey, (key) =>
              client.WaitSignal({
                payload,
                requestKey: key,
                waitId: config.id,
              })
            );
          })
        )
    ),
  ])
);
const automaticReclamation = Command.make("automatic").pipe(
  Command.withDescription(
    "Opt in to background deletion under existing policies; newest versions and run/reader/report holds remain protected"
  ),
  Command.withSubcommands([
    Command.make("status", {}, () =>
      withClient((client) =>
        Effect.gen(function* () {
          yield* automaticRetentionFor(client);
          yield* client
            .LakeReclamationAutomaticGet({})
            .pipe(Effect.flatMap(print));
        })
      )
    ),
    ...(["enable", "disable"] as const).map((action) =>
      Command.make(action, {}, () =>
        withClient((client) =>
          Effect.gen(function* () {
            yield* automaticRetentionFor(client);
            const status = yield* client
              .LakeReclamationAutomaticSet({ enabled: action === "enable" })
              .pipe(
                Effect.tapError((error) =>
                  error instanceof OperationError
                    ? Effect.void
                    : Console.error(
                        "Delivery uncertain. Inspect lake reclaim automatic status or repeat the desired setting."
                      )
                )
              );
            if (!(yield* root).json) {
              yield* Console.error(
                action === "enable"
                  ? "Automatic retention enabled: existing and future policy-eligible content may be deleted without individual previews."
                  : "Automatic retention disabled: no new automatic deletions will be committed; already-committed blob cleanup may finish."
              );
            }
            yield* print(status);
          })
        )
      )
    ),
  ])
);
const reclaim = Command.make("reclaim").pipe(
  Command.withDescription(
    "Preview and apply content reclamation. If hasMore is true, repeat plan then apply; plans expire after 15 minutes."
  ),
  Command.withSubcommands([
    automaticReclamation,
    Command.make(
      "plan",
      {
        artifact: Flag.String("artifact").pipe(Flag.optional),
        keepLatest: Flag.Int("keep-latest").pipe(Flag.optional),
        olderThan: Flag.String("older-than").pipe(Flag.optional),
        policy: Flag.Boolean("policy").pipe(Flag.withDefault(false)),
        schema: Flag.String("schema").pipe(Flag.optional),
        schemaVersion: Flag.Int("schema-version").pipe(Flag.optional),
        version: Flag.Int("version").pipe(Flag.optional),
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            const request = yield* Effect.try({
              catch: (error) => error as OperationError,
              try: () =>
                parseReclamation({
                  policy: config.policy,
                  ...(Option.isSome(config.schema)
                    ? { schema: config.schema.value }
                    : {}),
                  ...(Option.isSome(config.schemaVersion)
                    ? { schemaVersion: config.schemaVersion.value }
                    : {}),
                  ...(Option.isSome(config.artifact)
                    ? { artifact: config.artifact.value }
                    : {}),
                  ...(Option.isSome(config.version)
                    ? { version: config.version.value }
                    : {}),
                  ...(Option.isSome(config.olderThan)
                    ? { olderThan: config.olderThan.value }
                    : {}),
                  ...(Option.isSome(config.keepLatest)
                    ? { keepLatest: config.keepLatest.value }
                    : {}),
                }),
            });
            yield* retentionFor(client);
            yield* client.LakeReclamationPlan(request).pipe(
              Effect.tap((plan) =>
                plan.protectedVersions > 0
                  ? Console.error(
                      `${plan.protectedVersions} eligible versions are protected by unfinished producers, consumers, or pending reports. Use lake versions to inspect holds, run get / run cancel for runs, and report list / report cancel for reports. Wait for terminal settlement, then preview again.`
                    )
                  : Effect.void
              ),
              Effect.flatMap(print)
            );
          })
        )
    ),
    Command.make("apply", { planId: Argument.String("planId") }, ({ planId }) =>
      withClient((client) =>
        Effect.gen(function* () {
          yield* retentionFor(client);
          yield* client.LakeReclamationApply({ planId }).pipe(
            Effect.tapError((error) =>
              error instanceof OperationError
                ? Effect.void
                : Console.error(
                    `Delivery uncertain. Retry lake reclaim apply ${planId}; the plan id preserves the receipt even after expiry.`
                  )
            ),
            Effect.flatMap(print)
          );
        })
      )
    ),
  ])
);
const lake = Command.make("lake").pipe(
  Command.withSubcommands([
    reclaim,
    Command.make(
      "download",
      {
        id: idFlag,
        output: Flag.String("output"),
        version: Flag.Int("version"),
      },
      ({ id, version, output }) =>
        Effect.gen(function* () {
          const config = yield* root;
          yield* download(
            path.resolve(config.repository),
            id,
            version,
            output
          ).pipe(Effect.flatMap(print));
        })
    ),
    Command.make(
      "versions",
      {
        ...pageFlags,
        id: idFlag,
        includeReclaimed: Flag.Boolean("include-reclaimed").pipe(
          Flag.withDefault(false)
        ),
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            if (config.includeReclaimed) {
              yield* retentionFor(client);
            }
            yield* client
              .LakeVersions({
                ...page(config),
                artifactId: config.id,
                ...(config.includeReclaimed ? { includeReclaimed: true } : {}),
              })
              .pipe(Effect.flatMap(print));
          })
        )
    ),
    Command.make(
      "get",
      { id: idFlag, version: Flag.Int("version") },
      ({ id, version }) =>
        withClient((client) =>
          client
            .LakeGet({ artifactId: id, version })
            .pipe(Effect.flatMap(print))
        )
    ),
    Command.make(
      "query",
      {
        cursor: Flag.String("cursor").pipe(Flag.optional),
        file: Flag.String("file"),
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            const input = yield* parseInput(
              Option.none(),
              Option.some(config.file)
            );
            const query = yield* Schema.decodeUnknownEffect(Query)(input, {
              onExcessProperty: "error",
            });
            yield* client
              .LakeQuery({
                query,
                ...(Option.isSome(config.cursor)
                  ? { cursor: config.cursor.value }
                  : {}),
              })
              .pipe(Effect.flatMap(print));
          })
        )
    ),
  ])
);
/** Authoring types come from the project's SDK; warn when they differ from the host. */
const warnSdk = (repository: string) =>
  projectStatus(repository, cliPackage.version).pipe(
    Effect.flatMap((status) => {
      const warning = projectWarning(status);
      return warning === null ? Effect.void : Console.error(warning);
    }),
    Effect.ignore
  );
const daemon = Command.make("daemon").pipe(
  Command.withSubcommands([
    Command.make("serve", {}, () =>
      Effect.flatMap(root, (config) =>
        serve(path.resolve(config.repository), {
          onShutdownTimeout: () => process.exit(0),
        })
      )
    ),
    Command.make("status", {}, () =>
      withClient((client) =>
        client.SystemStatus({}).pipe(Effect.flatMap(print))
      )
    ),
    Command.make(
      "stop",
      {
        grace: Flag.Int("grace-period-ms").pipe(Flag.withDefault(1000)),
        instanceId: Flag.String("instance-id").pipe(Flag.optional),
        requestKey: requestKeyFlag,
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            const repository = yield* root;
            const status = yield* client.SystemStatus({});
            const instanceId = Option.getOrElse(
              config.instanceId,
              () => status.instanceId
            );
            const requestKey = Option.getOrElse(config.requestKey, () =>
              crypto.randomUUID()
            );
            const endpoint = yield* Effect.try({
              catch: () =>
                new OperationError({
                  code: "Unavailable",
                  message: "Daemon endpoint changed before drain",
                }),
              try: () =>
                Schema.decodeUnknownSync(Endpoint)(
                  JSON.parse(
                    readFileSync(
                      path.join(
                        repository.repository,
                        ".effectory/daemon.json"
                      ),
                      "utf-8"
                    )
                  )
                ),
            });
            const receipt = yield* client
              .SystemDrain({
                gracePeriodMs: config.grace,
                instanceId,
                requestKey,
              })
              .pipe(
                Effect.tapError((error) =>
                  error instanceof OperationError
                    ? Effect.void
                    : Console.error(
                        `Drain delivery is uncertain. Retry with --instance-id ${instanceId} --request-key ${requestKey} --grace-period-ms ${config.grace}`
                      )
                )
              );
            yield* print(receipt);
            if (endpoint.instanceId !== receipt.instanceId) {
              return;
            }
            const deadline = receipt.deadline + 5000;
            while (Date.now() < deadline) {
              const alive = yield* Effect.sync(() => {
                try {
                  process.kill(endpoint.pid, 0);
                  return true;
                } catch {
                  return false;
                }
              });
              if (!alive) {
                return;
              }
              yield* Effect.sleep("50 millis");
            }
            return yield* new OperationError({
              code: "Unavailable",
              message:
                "Drain was accepted but process exit was not observed within the shutdown bound",
            });
          })
        )
    ),
    Command.make("start", {}, () =>
      Effect.gen(function* () {
        const config = yield* root;
        const repository = path.resolve(config.repository);
        const existing = yield* Effect.exit(Effect.scoped(connect(repository)));
        if (Exit.isSuccess(existing)) {
          yield* withClient((client) =>
            client.SystemStatus({}).pipe(Effect.flatMap(print))
          );
          return;
        }
        const child = yield* Effect.sync(() => {
          const directory = path.join(repository, ".effectory");
          mkdirSync(directory, { mode: 0o700, recursive: true });
          const log = openSync(path.join(directory, "daemon.log"), "a", 0o600);
          try {
            const [executable = process.execPath, ...args] = selfCommand(
              import.meta.filename,
              ["daemon", "serve", "--repository", repository]
            );
            const spawned = spawn(executable, args, {
              detached: true,
              stdio: ["ignore", log, log],
            });
            spawned.unref();
            return spawned;
          } finally {
            closeSync(log);
          }
        });
        for (let attempt = 0; attempt < 1200; attempt += 1) {
          const result = yield* Effect.exit(
            withClient((client) => client.SystemStatus({}))
          );
          if (Exit.isSuccess(result)) {
            yield* print(result.value);
            yield* warnSdk(repository);
            return;
          }
          if (child.exitCode !== null) {
            break;
          }
          yield* Effect.sleep("100 millis");
        }
        return yield* new OperationError({
          code: "Unavailable",
          message:
            "Daemon did not become ready within two minutes; report search migration may still be running. Inspect .effectory/daemon.log and check daemon status before starting it again.",
        });
      })
    ),
  ])
);

const extensionMutationFlags = {
  expectedRevision: Flag.String("expected-revision").pipe(Flag.optional),
  requestKey: requestKeyFlag,
};
const trustFlag = Flag.Boolean("trust").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Trust the resolved packages and dependencies to execute privileged code on this machine"
  )
);
function extensionMutation<A, E>(
  config: {
    readonly expectedRevision: Option.Option<string>;
    readonly requestKey: Option.Option<string>;
  },
  submit: (
    client: Client,
    identity: { readonly expectedRevision: string; readonly requestKey: string }
  ) => Effect.Effect<A, E>
) {
  return withClient((client) =>
    Effect.gen(function* () {
      const expectedRevision = Option.isSome(config.expectedRevision)
        ? config.expectedRevision.value
        : (yield* client.SystemStatus({})).installedRegistryRevision;
      const requestKey = Option.getOrElse(config.requestKey, () =>
        crypto.randomUUID()
      );
      const receipt = yield* submit(client, {
        expectedRevision,
        requestKey,
      }).pipe(
        Effect.tapError((error) =>
          error instanceof OperationError
            ? Effect.void
            : Console.error(
                `Extension submission delivery is uncertain. Retry with --request-key ${requestKey} --expected-revision ${expectedRevision}`
              )
        )
      );
      yield* print(receipt);
    })
  );
}
const scheduleHint = (value: {
  readonly blockedBy: {
    readonly runId: string;
    readonly status: string;
  } | null;
}) =>
  Effect.gen(function* () {
    const config = yield* root;
    if (!config.json && value.blockedBy) {
      const { runId, status } = value.blockedBy;
      yield* Console.error(
        `Blocked by ${runId} (${status}). Inspect with run get ${runId}${status === "Waiting" ? ` or run waits ${runId}` : `; cancel with run cancel ${runId}`}.`
      );
    }
  });
const scheduleMutation = (
  id: string,
  paused: boolean,
  key: Option.Option<string>,
  reason: Option.Option<string> = Option.none()
) =>
  withClient((client) =>
    Effect.gen(function* () {
      const requestKey = Option.getOrElse(key, () => crypto.randomUUID());
      const request = { requestKey, scheduleId: id };
      const receipt = yield* (
        paused
          ? client.SchedulePause({
              ...request,
              ...optionalText("reason", reason),
            })
          : client.ScheduleResume(request)
      ).pipe(
        Effect.tapError((failure) =>
          failure instanceof OperationError
            ? Effect.void
            : Console.error(
                `Schedule mutation delivery is uncertain. Retry with --request-key ${requestKey} and the same schedule, operation and reason.`
              )
        )
      );
      yield* print(receipt);
    })
  );
const schedule = Command.make("schedule").pipe(
  Command.withSubcommands([
    Command.make(
      "list",
      {
        ...pageFlags,
        state: Flag.Literals("state", [
          "active",
          "blocked",
          "paused",
          "removed",
        ]).pipe(Flag.optional),
        workflow: Flag.String("workflow").pipe(Flag.optional),
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            const states = {
              active: "Active",
              blocked: "Blocked",
              paused: "Paused",
              removed: "Removed",
            };
            const request = yield* Schema.decodeUnknownEffect(
              ScheduleListRequest
            )({
              ...page(config),
              ...optionalText("workflowId", config.workflow),
              ...(Option.isSome(config.state)
                ? { state: states[config.state.value] }
                : {}),
            });
            const result = yield* client.ScheduleList(request);
            yield* print(result);
            for (const item of result.items) {
              yield* scheduleHint(item);
            }
          })
        )
    ),
    Command.make("get", { id: idFlag }, ({ id }) =>
      withClient((client) =>
        Effect.gen(function* () {
          const result = yield* client.ScheduleGet({ scheduleId: id });
          yield* print(result);
          yield* scheduleHint(result);
        })
      )
    ),
    Command.make("history", { id: idFlag, ...pageFlags }, (config) =>
      withClient((client) =>
        client
          .ScheduleHistory({ scheduleId: config.id, ...page(config) })
          .pipe(Effect.flatMap(print))
      )
    ),
    Command.make(
      "pause",
      {
        id: idFlag,
        reason: Flag.String("reason").pipe(Flag.optional),
        requestKey: requestKeyFlag,
      },
      ({ id, requestKey, reason }) =>
        scheduleMutation(id, true, requestKey, reason)
    ),
    Command.make(
      "resume",
      { id: idFlag, requestKey: requestKeyFlag },
      ({ id, requestKey }) => scheduleMutation(id, false, requestKey)
    ),
  ])
);

const operation = Command.make("operation").pipe(
  Command.withSubcommands([
    Command.make("get", { id: idFlag }, ({ id }) =>
      withClient((client) =>
        client.OperationGet({ operationId: id }).pipe(Effect.flatMap(print))
      )
    ),
    Command.make(
      "list",
      {
        ...pageFlags,
        afterSequence: Flag.Int("after-sequence").pipe(Flag.optional),
        kind: Flag.String("kind").pipe(Flag.optional),
        status: Flag.String("status").pipe(Flag.optional),
      },
      (config) =>
        withClient((client) =>
          Effect.gen(function* () {
            const request = yield* Schema.decodeUnknownEffect(
              OperationListRequest
            )({
              ...page(config),
              ...optionalText("kind", config.kind),
              ...optionalText("status", config.status),
              ...(Option.isSome(config.afterSequence)
                ? { afterSequence: config.afterSequence.value }
                : {}),
            });
            yield* client.OperationList(request).pipe(Effect.flatMap(print));
          })
        )
    ),
  ])
);

const extension = Command.make("extension").pipe(
  Command.withSubcommands([
    Command.make(
      "outdated",
      {
        afterId: Flag.String("after").pipe(Flag.optional),
        limit: Flag.Int("limit").pipe(Flag.withDefault(20)),
        revision: revisionFlag,
      },
      (config) =>
        withClient((client) =>
          client
            .ExtensionOutdated({
              limit: config.limit,
              ...revision(config.revision),
              ...(Option.isSome(config.afterId)
                ? { afterId: config.afterId.value }
                : {}),
            })
            .pipe(Effect.flatMap(print))
        )
    ),

    Command.make("list", {}, () =>
      withClient((client) =>
        client.ExtensionList({}).pipe(Effect.flatMap(print))
      )
    ),
    Command.make("describe", { id: idFlag }, ({ id }) =>
      withClient((client) =>
        client.ExtensionDescribe({ id }).pipe(Effect.flatMap(print))
      )
    ),
    Command.make(
      "add",
      {
        ...extensionMutationFlags,
        assetName: Flag.String("asset").pipe(Flag.withDefault("effectory.tgz")),
        bindingName: Flag.String("as").pipe(Flag.optional),
        source: Argument.String("github-source"),
        trust: trustFlag,
      },
      (config) =>
        extensionMutation(config, (client, identity) =>
          Effect.gen(function* () {
            const source = yield* Effect.try({
              catch: () =>
                new OperationError({
                  code: "InvalidInput",
                  message:
                    "Use github:owner/repository@release-tag with a valid asset name",
                }),
              try: () => parseSource(config.source, config.assetName),
            });
            return yield* client.ExtensionAdd({
              ...identity,
              source,
              trust: config.trust,
              ...(Option.isSome(config.bindingName)
                ? { bindingName: config.bindingName.value }
                : {}),
            });
          })
        )
    ),
    Command.make(
      "update",
      {
        ...extensionMutationFlags,
        id: idFlag,
        ref: Flag.String("to"),
        trust: trustFlag,
      },
      (config) =>
        extensionMutation(config, (client, identity) =>
          client.ExtensionUpdate({
            ...identity,
            id: config.id,
            ref: config.ref,
            trust: config.trust,
          })
        )
    ),
    Command.make(
      "remove",
      { ...extensionMutationFlags, id: idFlag },
      (config) =>
        extensionMutation(config, (client, identity) =>
          client.ExtensionRemove({ ...identity, id: config.id })
        )
    ),

    Command.make(
      "restore",
      {
        trust: Flag.Boolean("trust").pipe(
          Flag.withDefault(false),
          Flag.withDescription(
            "Trust the exact locked packages and their dependencies to execute privileged code on this machine"
          )
        ),
      },
      ({ trust }) =>
        Effect.gen(function* () {
          const config = yield* root;
          const result = yield* restoreExtensions(
            path.resolve(config.repository),
            { trust }
          );
          yield* print(result);
        })
    ),
  ])
);

const versionCommand = Command.make("version", {}, () =>
  print({
    abi: hostAbi(),
    bun: Bun.version,
    compiled,
    effectory: cliPackage.version,
    sdk: hostVersions,
  })
);
/** Like `swamp repo upgrade`: record this version and pin the SDK to it. */
const upgrade = Command.make("upgrade", {}, () =>
  Effect.flatMap(root, (config) =>
    upgradeProject(path.resolve(config.repository), cliPackage.version).pipe(
      Effect.flatMap(print)
    )
  )
).pipe(
  Command.withDescription(
    "Bare upgrade updates dependency pins only. Offline plan, apply and inspect manage runtime transitions."
  ),
  Command.withSubcommands([
    Command.make("plan", {}, () =>
      Effect.flatMap(root, (config) =>
        runtimeUpgrade(path.resolve(config.repository), { kind: "Plan" }).pipe(
          Effect.flatMap(print)
        )
      )
    ),
    Command.make(
      "inspect",
      { planId: Argument.String("plan-id") },
      ({ planId }) =>
        Effect.flatMap(root, (config) =>
          runtimeUpgrade(path.resolve(config.repository), {
            kind: "Inspect",
            planId,
          }).pipe(Effect.flatMap(print))
        )
    ),
    Command.make(
      "apply",
      { planId: Argument.String("plan-id") },
      ({ planId }) =>
        Effect.flatMap(root, (config) =>
          runtimeUpgrade(path.resolve(config.repository), {
            kind: "Apply",
            planId,
          }).pipe(Effect.flatMap(print))
        )
    ),
  ])
);
/** Like `swamp repo init [path]`; the path defaults to `--repository`. */
const init = Command.make(
  "init",
  { path: Argument.String("path").pipe(Argument.optional) },
  (args) =>
    Effect.flatMap(root, (config) =>
      initProject(
        path.resolve(Option.getOrElse(args.path, () => config.repository)),
        cliPackage.version
      ).pipe(Effect.flatMap(print))
    )
);
/** `doctor` asks the daemon; `doctor sdk` checks the project locally. */
const doctor = Command.make("doctor", {}, () =>
  withClient((client) => client.SystemDoctor({}).pipe(Effect.flatMap(print)))
).pipe(
  Command.withSubcommands([
    Command.make("sdk", {}, () =>
      Effect.gen(function* () {
        const config = yield* root;
        const status = yield* projectStatus(
          path.resolve(config.repository),
          cliPackage.version
        );
        yield* print(status);
        if (!status.ok) {
          exitCode = 1;
        }
      })
    ),
  ])
);

const vaultFlags = { revision: revisionFlag, vault: Argument.String("vault") };
const vaultRequest = (config: {
  vault: string;
  revision: Option.Option<string>;
}) => ({ vault: config.vault, ...revision(config.revision) });
const vaultClient = <A, E, R>(
  body: (client: Client, revision: string) => Effect.Effect<A, E, R>
) =>
  withClient((client) =>
    Effect.gen(function* () {
      const status = yield* client.SystemStatus({});
      if (!status.capabilities.includes("vault.v1")) {
        return yield* new OperationError({
          code: "Unavailable",
          message:
            "Restart the daemon to enable vaults: effectory daemon stop && effectory daemon start",
        });
      }
      return yield* body(client, status.revision);
    })
  );
const vault = Command.make("vault").pipe(
  Command.withSubcommands([
    Command.make("list", { revision: revisionFlag }, (config) =>
      vaultClient((client) =>
        client.VaultList(revision(config.revision)).pipe(Effect.flatMap(print))
      )
    ),
    Command.make("describe", vaultFlags, (config) =>
      vaultClient((client) =>
        client.VaultDescribe(vaultRequest(config)).pipe(Effect.flatMap(print))
      )
    ),
    Command.make("init", vaultFlags, (config) =>
      vaultClient((client) =>
        client.VaultInit(vaultRequest(config)).pipe(Effect.flatMap(print))
      )
    ),
    Command.make(
      "put",
      {
        ...vaultFlags,
        expectedVersion: Flag.String("if-version"),
        file: Flag.String("file"),
        key: Argument.String("key"),
        requestKey: requestKeyFlag,
      },
      (config) =>
        vaultClient((client, activeRevision) =>
          Effect.gen(function* () {
            const value = yield* readSecret(config.file);
            if (/[\r\n]$/u.test(value)) {
              yield* Console.error(
                "Value ends with a line break; stored exactly"
              );
            }
            if (new TextEncoder().encode(value).byteLength < 8) {
              yield* Console.error(
                "Value is shorter than eight bytes; value-based output protection does not cover it"
              );
            }
            const requestKey = Option.getOrElse(config.requestKey, () =>
              crypto.randomUUID()
            );
            const selectedRevision = Option.getOrElse(
              config.revision,
              () => activeRevision
            );
            const result = yield* client
              .VaultPut({
                ...vaultRequest(config),
                expectedVersion: config.expectedVersion,
                key: config.key,
                requestKey,
                revision: selectedRevision,
                value,
              })
              .pipe(
                Effect.tapError((error) =>
                  error instanceof RpcClientError.RpcClientError
                    ? Console.error(
                        `Vault mutation delivery is uncertain. Retry the same input and version with --request-key ${requestKey} --revision ${selectedRevision}`
                      ).pipe(Effect.ignoreCause)
                    : Effect.void
                )
              );
            yield* print(result);
          })
        )
    ),
    Command.make(
      "delete",
      {
        ...vaultFlags,
        expectedVersion: Flag.String("if-version"),
        key: Argument.String("key"),
        requestKey: requestKeyFlag,
      },
      (config) =>
        vaultClient((client, activeRevision) =>
          Effect.gen(function* () {
            const requestKey = Option.getOrElse(config.requestKey, () =>
              crypto.randomUUID()
            );
            const selectedRevision = Option.getOrElse(
              config.revision,
              () => activeRevision
            );
            const result = yield* client
              .VaultDelete({
                ...vaultRequest(config),
                expectedVersion: config.expectedVersion,
                key: config.key,
                requestKey,
                revision: selectedRevision,
              })
              .pipe(
                Effect.tapError((error) =>
                  error instanceof RpcClientError.RpcClientError
                    ? Console.error(
                        `Vault mutation delivery is uncertain. Retry with --request-key ${requestKey} --revision ${selectedRevision}`
                      ).pipe(Effect.ignoreCause)
                    : Effect.void
                )
              );
            yield* print(result);
          })
        )
    ),
    Command.make(
      "reveal",
      {
        ...vaultFlags,
        key: Argument.String("key"),
        output: Flag.String("output").pipe(Flag.optional),
      },
      (config) =>
        Effect.gen(function* () {
          const shared = yield* root;
          if (shared.json) {
            return yield* new OperationError({
              code: "InvalidInput",
              message:
                "vault reveal returns raw bytes and does not accept --json",
            });
          }
          yield* vaultClient((client) =>
            client
              .VaultReveal({ ...vaultRequest(config), key: config.key })
              .pipe(
                Effect.flatMap((result) =>
                  writeSecret(
                    shared.repository,
                    result.value,
                    Option.getOrUndefined(config.output)
                  )
                )
              )
          );
        })
    ),
    Command.make(
      "reset",
      { discard: Flag.Boolean("discard"), vault: Argument.String("vault") },
      (config) =>
        Effect.gen(function* () {
          if (!config.discard) {
            return yield* new OperationError({
              code: "InvalidInput",
              message:
                "Offline vault reset destroys all local values; pass --discard",
            });
          }
          const shared = yield* root;
          yield* offlineVault(shared.repository, (store) =>
            store.reset(config.vault)
          ).pipe(Effect.flatMap(print));
        })
    ),
    Command.make("key").pipe(
      Command.withSubcommands([
        Command.make(
          "export",
          { output: Flag.String("output"), vault: Argument.String("vault") },
          (config) =>
            Effect.gen(function* () {
              const shared = yield* root;
              yield* offlineVault(shared.repository, (store) =>
                store.exportKey(config.vault, config.output)
              ).pipe(Effect.flatMap(print));
            })
        ),
        Command.make(
          "import",
          { file: Flag.String("file"), vault: Argument.String("vault") },
          (config) =>
            Effect.gen(function* () {
              const shared = yield* root;
              yield* offlineVault(shared.repository, (store) =>
                store.importKey(config.vault, config.file)
              ).pipe(Effect.flatMap(print));
            })
        ),
      ])
    ),
  ])
);

const agent = Command.make("agent", {}, () =>
  print({ commands: ["setup", "status", "remove"] })
).pipe(
  Command.withSubcommands([
    ...(["setup", "remove"] as const).map((mode) =>
      Command.make(
        mode,
        {
          dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
          harness: Flag.Literals("harness", ["codex", "claude-code"]).pipe(
            Flag.atMost(2)
          ),
        },
        (args) =>
          Effect.gen(function* () {
            const config = yield* root;
            yield* agentMutation(
              config.repository,
              cliPackage.version,
              mode,
              args.harness,
              args.dryRun
            ).pipe(Effect.flatMap(print));
          })
      )
    ),
    Command.make("status", {}, () =>
      Effect.gen(function* () {
        const config = yield* root;
        const status = yield* agentStatus(
          config.repository,
          cliPackage.version
        );
        if (!status.healthy) {
          exitCode = 1;
        }
        yield* print(status);
      })
    ),
  ])
);
const command = root.pipe(
  Command.withSubcommands([
    init,
    agent,
    upgrade,
    versionCommand,
    daemon,
    Command.make(
      "backup",
      { destination: Argument.String("destination") },
      ({ destination }) =>
        Effect.gen(function* () {
          const config = yield* root;
          yield* repositorySnapshot(config.repository, destination, false).pipe(
            Effect.flatMap(print)
          );
        })
    ),
    Command.make(
      "restore",
      { snapshot: Argument.String("snapshot") },
      ({ snapshot }) =>
        Effect.gen(function* () {
          const config = yield* root;
          yield* repositorySnapshot(snapshot, config.repository, true).pipe(
            Effect.flatMap(print)
          );
        })
    ),
    doctor,
    extension,
    operation,
    schedule,
    vault,
    definitions("task"),
    definitions("workflow"),
    runCommands,
    reportCommands,
    lake,
  ])
);
const cli = () =>
  BunRuntime.runMain(
    Command.run(command, { version: cliPackage.version }).pipe(
      Effect.provide(BunServices.layer),
      Effect.tapError((failure) =>
        Console.error(
          failure instanceof OperationError ? failure.message : "Command failed"
        )
      )
    ),
    {
      disableErrorReporting: true,
      teardown: (exit, done) => {
        if (Exit.isSuccess(exit)) {
          done(exitCode);
          return;
        }
        const failure = Cause.findErrorOption(exit.cause);
        if (Option.isSome(failure) && failure.value instanceof OperationError) {
          const { code } = failure.value;
          const codes: Record<string, number> = {
            InvalidInput: 2,
            Unavailable: 3,
          };
          done(codes[code] ?? 5);
          return;
        }
        if (
          Option.isSome(failure) &&
          failure.value instanceof RpcClientError.RpcClientError
        ) {
          done(3);
          return;
        }
        done(Cause.hasInterrupts(exit.cause) ? 130 : 2);
      },
    }
  );

if (Bun.argv[2] === internalCommand) {
  await runInternalCommand(Bun.argv.slice(3));
} else {
  cli();
}

#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { checkJsonBudget } from "@effectory/core/internal/boundary";
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
import {
  initProject,
  projectStatus,
  projectWarning,
  upgradeProject,
} from "@effectory/platform-bun/sdk";
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
import { Cause, Console, Effect, Exit, Option, Schema, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { RpcClientError } from "effect/rpc";

import cliPackage from "../package.json" with { type: "json" };
import { writeJsonLine } from "./json-lines.ts";

const root = Command.make("effectory").pipe(
  Command.withSharedFlags({
    json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
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

function observe(client: Client, runId: string, untilWaiting: boolean) {
  return Effect.gen(function* () {
    yield* client.RunWatch({ runId }).pipe(
      Stream.takeUntil(
        (frame) =>
          frame._tag === "Snapshot" &&
          (terminal.has(frame.run.status) ||
            (untilWaiting &&
              (frame.run.status === "Waiting" ||
                frame.run.status === "NeedsAttention")))
      ),
      Stream.runDrain
    );
    const run = yield* client.RunGet({ runId });
    yield* print(run);
    exitCode = terminal.has(run.status) ? 1 : 4;
    if (run.status === "Succeeded") {
      exitCode = 0;
    }
  });
}
function observeJsonLines(
  client: Client,
  runId: string,
  afterSequence: number
) {
  return Effect.gen(function* () {
    let after = afterSequence;
    yield* client.RunWatch({ afterSequence, runId }).pipe(
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
      Effect.tapError((error) =>
        error instanceof OperationError
          ? Effect.void
          : Console.error(
              `Observation disconnected. Resume run watch ${runId} --jsonl --after-sequence ${after}`
            )
      )
    );
    const run = yield* client.RunGet({ runId });
    exitCode = run.status === "Succeeded" ? 0 : 1;
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
      background: Flag.Boolean("background").pipe(Flag.withDefault(false)),
      id: idFlag,
      requestKey: requestKeyFlag,
      revision: revisionFlag,
    },
    (config) =>
      withClient((client) =>
        Effect.gen(function* () {
          const input = yield* parseInput(config.input, config.inputFile);
          const requestKey = Option.getOrElse(config.requestKey, () =>
            crypto.randomUUID()
          );
          const result = yield* client[
            kind === "task" ? "TaskRun" : "WorkflowRun"
          ]({
            id: config.id,
            input,
            requestKey,
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
          yield* observe(client, result.runId, true);
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

const runCommands = Command.make("run").pipe(
  Command.withSubcommands([
    Command.make(
      "list",
      {
        ...pageFlags,
        createdAfter: Flag.String("created-after").pipe(Flag.optional),
        createdBefore: Flag.String("created-before").pipe(Flag.optional),
        kind: Flag.String("kind").pipe(Flag.optional),
        status: Flag.String("status").pipe(Flag.optional),
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
            const status = Option.isSome(config.status)
              ? yield* Schema.decodeUnknownEffect(RunStatus)(
                  config.status.value
                )
              : null;
            yield* client
              .RunList({
                ...page(config),
                ...optionalText("targetId", config.targetId),
                ...optionalText("createdAfter", config.createdAfter),
                ...optionalText("createdBefore", config.createdBefore),
                ...(kind === null ? {} : { kind }),
                ...(status === null ? {} : { status }),
              })
              .pipe(Effect.flatMap(print));
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
          jsonl
            ? observeJsonLines(client, id, afterSequence)
            : observe(client, id, false)
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
const lake = Command.make("lake").pipe(
  Command.withSubcommands([
    Command.make("versions", { ...pageFlags, id: idFlag }, (config) =>
      withClient((client) =>
        client
          .LakeVersions({ ...page(config), artifactId: config.id })
          .pipe(Effect.flatMap(print))
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
        for (let attempt = 0; attempt < 150; attempt += 1) {
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
          message: "Daemon did not become ready; inspect .effectory/daemon.log",
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

const command = root.pipe(
  Command.withSubcommands([
    init,
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
    definitions("task"),
    definitions("workflow"),
    runCommands,
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

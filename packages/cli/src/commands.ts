import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { startRuntime } from "@effectory/runtime";
import { Console, Effect, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { workflowDescription, workflowList } from "./format.ts";
import type { WorkflowDescription, WorkflowSummary } from "./format.ts";
import {
  cancelLocal,
  executeLocal,
  requestLocal,
  runtimeError,
} from "./local-runtime.ts";

const workspace = Flag.String("workspace").pipe(Flag.withDefault("."));
const json = Flag.Boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print machine-readable JSON")
);
const print = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

const serve = Command.make("serve", { workspace }, ({ workspace: root }) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      catch: runtimeError,
      try: () => startRuntime(root),
    }),
    (server) =>
      print({
        socket: server.socket,
        status: "ready",
        workspace: server.workspace,
      }).pipe(Effect.andThen(Effect.never)),
    (server) => Effect.promise(() => server.close())
  )
).pipe(
  Command.withDescription(
    "Optionally host this workspace's engine for long-lived integrations."
  )
);

const workflow = Command.make("workflow").pipe(
  Command.withDescription("List, describe, and run registered workflows."),
  Command.withSubcommands([
    Command.make(
      "list",
      { json, workspace },
      ({ json: asJson, workspace: root }) =>
        requestLocal(root, { method: "task.list" }).pipe(
          Effect.flatMap((workflows) =>
            asJson
              ? print(workflows)
              : Console.log(
                  workflowList(workflows as readonly WorkflowSummary[])
                )
          )
        )
    ),
    Command.make(
      "describe",
      { json, name: Argument.String("name"), workspace },
      ({ json: asJson, name, workspace: root }) =>
        requestLocal(root, { method: "task.describe", name }).pipe(
          Effect.flatMap((described) =>
            asJson
              ? print(described)
              : Console.log(
                  workflowDescription(described as WorkflowDescription)
                )
          )
        )
    ),
    Command.make(
      "run",
      {
        input: Flag.String("input"),
        name: Argument.String("name"),
        requestKey: Flag.String("request-key").pipe(Flag.withDefault("")),
        workspace,
      },
      ({ name, input: filename, requestKey, workspace: root }) =>
        Effect.tryPromise({
          catch: runtimeError,
          try: async () =>
            JSON.parse(await readFile(filename, "utf-8")) as unknown,
        }).pipe(
          Effect.flatMap((input) =>
            executeLocal(root, {
              input,
              method: "task.run",
              requestKey: requestKey || randomUUID(),
              task: name,
            })
          )
        )
    ),
  ])
);

const run = Command.make("run").pipe(
  Command.withSubcommands([
    Command.make(
      "resume",
      { id: Argument.String("id"), workspace },
      ({ id, workspace: root }) =>
        executeLocal(root, { id, method: "run.resume" })
    ),
    Command.make("list", { workspace }, ({ workspace: root }) =>
      requestLocal(root, { method: "run.list" }).pipe(Effect.flatMap(print))
    ),
    Command.make(
      "inspect",
      { id: Argument.String("id"), workspace },
      ({ id, workspace: root }) =>
        requestLocal(root, { id, method: "run.inspect" }).pipe(
          Effect.flatMap(print)
        )
    ),
    Command.make(
      "cancel",
      { id: Argument.String("id"), workspace },
      ({ id, workspace: root }) => cancelLocal(root, id)
    ),
  ])
);

const artifact = Command.make("artifact").pipe(
  Command.withSubcommands([
    Command.make(
      "list",
      {
        run: Flag.String("run").pipe(Flag.withDefault("")),
        workspace,
      },
      ({ run: runId, workspace: root }) =>
        requestLocal(root, {
          method: "artifact.list",
          ...(runId ? { runId } : {}),
        }).pipe(Effect.flatMap(print))
    ),
    Command.make(
      "get",
      { id: Argument.String("id"), workspace },
      ({ id, workspace: root }) =>
        requestLocal(root, { id, method: "artifact.get" }).pipe(
          Effect.flatMap(print)
        )
    ),
  ])
);

const Review = Schema.Struct({
  digest: Schema.String,
  id: Schema.String,
  review: Schema.Unknown,
  revision: Schema.String,
  title: Schema.String,
});

const decide = Effect.fn("Effectory.decideApproval")(function* decide(options: {
  workspace: string;
  id: string;
  digest: string;
  revision: string;
  outcome: "approved" | "rejected";
  reason?: string;
}) {
  let { digest, revision } = options;
  if (Boolean(digest) !== Boolean(revision)) {
    return yield* runtimeError(
      "Supply both --digest and --revision from the reviewed approval."
    );
  }
  if (!digest) {
    const review = yield* requestLocal(options.workspace, {
      id: options.id,
      method: "approval.inspect",
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Review)));
    if (options.outcome === "approved") {
      if (!process.stdin.isTTY) {
        return yield* runtimeError(
          "Inspect the approval first, then supply its --digest and --revision, or approve from an interactive terminal."
        );
      }
      yield* Console.error(JSON.stringify(review, null, 2));
      const answer = yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          createInterface({ input: process.stdin, output: process.stderr })
        ),
        (terminal) =>
          Effect.tryPromise({
            catch: runtimeError,
            try: (signal) =>
              terminal.question("Approve this reviewed plan? [y/N] ", {
                signal,
              }),
          }),
        (terminal) => Effect.sync(() => terminal.close())
      );
      if (answer.trim().toLowerCase() !== "y") {
        return yield* runtimeError("Approval was not confirmed.");
      }
    }
    ({ digest, revision } = review);
  }
  return yield* requestLocal(options.workspace, {
    digest,
    id: options.id,
    method: "approval.decide",
    outcome: options.outcome,
    revision,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  });
});

const reviewFlags = {
  digest: Flag.String("digest").pipe(Flag.withDefault("")),
  id: Argument.String("id"),
  revision: Flag.String("revision").pipe(Flag.withDefault("")),
  workspace,
};
const approval = Command.make("approval").pipe(
  Command.withSubcommands([
    Command.make("list", { workspace }, ({ workspace: root }) =>
      requestLocal(root, { method: "approval.list" }).pipe(
        Effect.flatMap(print)
      )
    ),
    Command.make(
      "inspect",
      { id: Argument.String("id"), workspace },
      ({ id, workspace: root }) =>
        requestLocal(root, { id, method: "approval.inspect" }).pipe(
          Effect.flatMap(print)
        )
    ),
    Command.make("approve", reviewFlags, (options) =>
      decide({ ...options, outcome: "approved" }).pipe(Effect.flatMap(print))
    ),
    Command.make(
      "reject",
      {
        ...reviewFlags,
        reason: Flag.String("reason"),
      },
      (options) =>
        decide({ ...options, outcome: "rejected" }).pipe(Effect.flatMap(print))
    ),
  ])
);

export const runtimeCommands = [workflow, run, artifact, approval, serve];

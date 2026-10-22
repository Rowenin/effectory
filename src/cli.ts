import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Argument, Command, Flag } from "effect/cli";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { httpCheckDescription } from "./automation/http-check.ts";
import {
  createCheck,
  initializeWorkspace,
  listResults,
  runCheck,
  WorkspaceError,
} from "./automation/workspace.ts";

const workspace = Flag.String("workspace").pipe(Flag.withDefault("."));
const printJson = (value: unknown) =>
  Console.log(JSON.stringify(value, null, 2));

const initialize = Command.make("init", { workspace }, ({ workspace: root }) =>
  initializeWorkspace(root).pipe(Effect.flatMap(printJson))
).pipe(
  Command.withDescription(
    "Initialize a workspace without overwriting existing files."
  )
);

const describe = Command.make(
  "describe",
  { type: Argument.String("type") },
  ({ type }) =>
    type === httpCheckDescription.type
      ? printJson(httpCheckDescription)
      : Effect.fail(
          new WorkspaceError({ message: `Unknown operation type: ${type}` })
        )
);

const create = Command.make(
  "create",
  {
    name: Argument.String("name"),
    timeout: Flag.Int("timeout").pipe(Flag.withDefault(5000)),
    url: Flag.String("url"),
    workspace,
  },
  ({ workspace: root, name, url, timeout }) =>
    createCheck(root, {
      config: { timeoutMs: timeout, url },
      name,
      type: "http/check",
      version: 1,
    }).pipe(Effect.flatMap(printJson))
);

const run = Command.make(
  "run",
  { name: Argument.String("name"), workspace },
  ({ workspace: root, name }) =>
    runCheck(root, name).pipe(Effect.flatMap(printJson))
);

const list = Command.make(
  "list",
  { name: Argument.String("name"), workspace },
  ({ workspace: root, name }) =>
    listResults(root, name).pipe(Effect.flatMap(printJson))
);

const cli = Command.make("automation").pipe(
  Command.withDescription(
    "Local typed operations with inspectable results. Commands return JSON."
  ),
  Command.withSubcommands([
    initialize,
    Command.make("type").pipe(Command.withSubcommands([describe])),
    Command.make("check").pipe(Command.withSubcommands([create, run])),
    Command.make("data").pipe(Command.withSubcommands([list])),
  ])
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.provide([FetchHttpClient.layer, BunServices.layer]),
  BunRuntime.runMain
);

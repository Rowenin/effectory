import * as BunServices from "@effect/platform-bun/BunServices";
import { initializeWorkspace } from "@effectory/runtime";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { runtimeCommands } from "./commands.ts";

const workspace = Flag.String("workspace").pipe(Flag.withDefault("."));
const initialize = (name: "init" | "start") =>
  Command.make(name, { workspace }, ({ workspace: root }) =>
    initializeWorkspace(root).pipe(
      Effect.flatMap((value) => Console.log(JSON.stringify(value, null, 2)))
    )
  );
const cli = Command.make("effectory").pipe(
  Command.withDescription("Offline Effect automation with local run history."),
  Command.withSubcommands([
    initialize("init"),
    initialize("start"),
    ...runtimeCommands,
  ])
);

/** Parse CLI arguments, delegate to runtime, and supply terminal/platform services. */
export const run = Command.run(cli, { version: "0.1.2" }).pipe(
  Effect.provide(BunServices.layer)
);

/** The `effectory` command tree. */
import { Command } from "effect/cli";

import { approval } from "./commands/approval.ts";
import { data, resource } from "./commands/data.ts";
import { action, run } from "./commands/run.ts";
import { describe, serve } from "./commands/serve.ts";
import { root } from "./runtime.ts";

export const version = "0.2.0";

export const cli = root.pipe(
  Command.withSubcommands([
    run,
    approval,
    action,
    data,
    resource,
    describe,
    serve,
  ])
);

/**
 * Accept `--junit <file>.xml` as well as `--junit=<file>`: a bare `--junit`
 * never consumes the next token, which may be the workflow argument.
 */
export const normalizeArgs = (args: readonly string[]): readonly string[] => {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const next = args[index + 1];
    if (arg === "--junit" && next !== undefined && next.endsWith(".xml")) {
      result.push(`--junit=${next}`);
      index += 1;
    } else {
      result.push(arg);
    }
  }
  return result;
};

/** Run the CLI over `args` (without the executable and script). */
export const main = (args: readonly string[]) =>
  Command.runWith(cli, { version })(normalizeArgs(args));

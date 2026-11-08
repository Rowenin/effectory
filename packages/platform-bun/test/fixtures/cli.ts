/* oxlint-disable no-await-in-loop */
// Readiness and state polling depend on each preceding observation and have deadlines.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ExtensionOperation } from "@effectory/runtime/extension-protocol";
import { WaitPage } from "@effectory/runtime/history-protocol";
import { Wait } from "@effectory/runtime/protocol";
import { Schema } from "effect";

export const main = path.resolve(import.meta.dir, "../../../cli/src/main.ts");
/**
 * The CLI under test. Set EFFECTORY_BINARY to a compiled executable to run the
 * process-level suites against it instead of the source entry point.
 */
const binary = process.env.EFFECTORY_BINARY;
export const effectory: readonly string[] =
  binary !== undefined && binary !== ""
    ? [path.resolve(binary)]
    : [process.execPath, main];
export async function cli(repository: string, args: readonly string[]) {
  const process = Bun.spawn(
    [...effectory, ...args, "--repository", repository, "--json"],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `CLI ${args.join(" ")} exited ${code}: ${stderr}\n${stdout}`
    );
  }
  return JSON.parse(stdout) as unknown;
}
export async function start(repository: string, environment = process.env) {
  const child = Bun.spawn(
    [...effectory, "daemon", "serve", "--repository", repository],
    { env: environment, stderr: "pipe", stdout: "pipe" }
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(await new Response(child.stderr).text());
    }
    try {
      const endpoint: unknown = JSON.parse(
        await readFile(path.join(repository, ".effectory/daemon.json"), "utf-8")
      );
      if (
        typeof endpoint === "object" &&
        endpoint !== null &&
        Reflect.get(endpoint, "pid") === child.pid
      ) {
        await cli(repository, ["daemon", "status"]);
        return child;
      }
    } catch {
      /* Startup has not published a current endpoint yet. */
    }
    await Bun.sleep(100);
  }
  child.kill("SIGKILL");
  await child.exited;
  throw new Error("Daemon did not become ready");
}
export async function operation(repository: string, id: string) {
  for (let count = 0; count < 100; count += 1) {
    const snapshot = Schema.decodeUnknownSync(ExtensionOperation)(
      await cli(repository, ["operation", "get", id])
    );
    if (snapshot.status === "Succeeded" || snapshot.status === "Failed") {
      return snapshot;
    }
    await Bun.sleep(50);
  }
  throw new Error("Extension operation did not settle");
}
export async function approval(repository: string, runId: string) {
  for (let count = 0; count < 100; count += 1) {
    const waits = Schema.decodeUnknownSync(WaitPage)(
      await cli(repository, ["run", "waits", runId])
    );
    const open = waits.items.find((wait) => wait.status === "Open");
    if (open) {
      return Schema.decodeUnknownSync(Wait)(
        await cli(repository, ["run", "wait", open.waitId])
      );
    }
    await Bun.sleep(50);
  }
  throw new Error("Approval did not open");
}

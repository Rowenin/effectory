import { mock } from "bun:test";
import * as fs from "node:fs";

// Kill at actual file publication and fsync boundaries without adding runtime
// fault injection switches to the shipped CLI.
const real = { ...fs };
const stop = Number(process.argv[3]);
let boundary = 0;
function checkpoint() {
  boundary += 1;
  if (boundary === stop) {
    process.kill(process.pid, "SIGKILL");
  }
}
await mock.module("node:fs", () => ({
  ...real,
  fsyncSync: (fd: number) => {
    real.fsyncSync(fd);
    checkpoint();
  },
  renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    real.renameSync(...args);
    checkpoint();
  },
  unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
    real.unlinkSync(...args);
    checkpoint();
  },
}));
const { Effect } = await import("effect");
const { agentMutation } = await import("../../src/agent-files.ts");
await Effect.runPromise(
  agentMutation(
    process.argv[2] ?? "missing-test-root",
    "0.1.0",
    process.argv[4] === "remove" ? "remove" : "setup",
    ["codex"],
    false
  )
);
process.stdout.write(String(boundary));

/* oxlint-disable no-await-in-loop -- Each crash boundary must recover before the next isolated process. */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { initProject } from "../../platform-bun/src/sdk.ts";
import { agentMutation, agentStatus } from "../src/agent-files.ts";

const worker = path.join(import.meta.dir, "fixtures/agent-crash.ts");
test.each(["setup", "remove"] as const)(
  "%s recovers from process death at each publication boundary and releases the lock",
  async (mode) => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "effectory-agent-crash-")
    );
    const initialize = async (name: string) => {
      const root = path.join(directory, name);
      await Effect.runPromise(initProject(root, "0.1.0"));
      writeFileSync(path.join(root, "AGENTS.md"), "personal\r\n");
      if (mode === "remove") {
        await Effect.runPromise(
          agentMutation(root, "0.1.0", "setup", ["codex"], false)
        );
      }
      return root;
    };
    try {
      const baseline = await initialize("baseline");
      const completed = Bun.spawnSync([
        process.execPath,
        worker,
        baseline,
        "0",
        mode,
      ]);
      expect(completed.exitCode).toBe(0);
      const boundaries = Number(completed.stdout.toString());
      expect(boundaries).toBeGreaterThan(20);
      for (let stop = 1; stop <= boundaries; stop += 1) {
        const root = await initialize(`crash-${stop}`);
        const crashed = Bun.spawnSync([
          process.execPath,
          worker,
          root,
          String(stop),
          mode,
        ]);
        expect(crashed.signalCode).toBe("SIGKILL");
        await Effect.runPromise(
          agentMutation(root, "0.1.0", mode, ["codex"], false)
        );
        const status = await Effect.runPromise(agentStatus(root, "0.1.0"));
        expect(status.healthy).toBe(true);
        expect(
          existsSync(path.join(root, ".effectory/agent-setup/journal.json"))
        ).toBe(false);
        expect(
          readdirSync(root, { recursive: true }).some((name) =>
            String(name).endsWith(".tmp")
          )
        ).toBe(false);
        rmSync(root, { recursive: true });
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  },
  180_000
);

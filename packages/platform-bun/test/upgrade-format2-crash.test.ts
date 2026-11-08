import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readRuntimeStorage } from "../src/runtime-storage-format.ts";
import { retargetVaultFence } from "../src/upgrade-vault-fence.ts";
import { format2Fixture } from "./fixtures/upgrade-format2-fixture.ts";

async function killed(
  directory: string,
  script: string,
  args: string[],
  stage: string
) {
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixtures", script), ...args],
    { stderr: "pipe", stdout: "ignore" }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(137);
    expect(readFileSync(path.join(directory, "checkpoint"), "utf-8")).toBe(
      stage
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

const stages = [
  "credentials-envelope-v2",
  "vault-format-v2",
  "extension-lock-v2",
  "checkpoint/Fenced/3",
  "checkpoint/Migrating/3",
  "checkpoint/Publishing/3",
  "runtime-storage-published",
  "checkpoint/Complete/4",
  "abort/vault",
  "abort/extensions",
  "abort/credentials",
];
test.each(
  stages.flatMap((stage) =>
    [false, true].map((realVault) => [stage, realVault] as const)
  )
)(
  "format-2 resumes SIGKILL at %s (real vault: %s)",
  async (stage, realVault) => {
    const f = await format2Fixture(realVault);
    try {
      await f.accept(
        stage.startsWith("abort/") ? "extension-lock-v2" : "accepted"
      );
      if (stage.startsWith("abort/")) {
        writeFileSync(path.join(f.repository, "edited"), "preserve");
      }
      await killed(
        f.directory,
        "upgrade-executor-crash.ts",
        [f.repository, f.saved.plan.planId, stage],
        stage
      );
      const result = await f.resume();
      const abort = stage.startsWith("abort/");
      expect(result.phase).toBe(abort ? "Aborted" : "Complete");
      expect(readRuntimeStorage(f.repository)?.targetBuild).toBe(
        (abort ? f.owner : f.nextOwner).targetBuild
      );
      if (realVault) {
        const vault = f.vault();
        try {
          expect(vault.reveal("credentials", "token")).toBe(
            "CANARY-fence-fixture"
          );
        } finally {
          vault.close();
        }
      }
      expect(await f.resume()).toEqual(result);
    } finally {
      f.cleanup();
    }
  },
  20_000
);

test.each([
  ["Protect", "vault-owner-written"],
  ["Protect", "vault-owner-committed"],
  ["Protect", "vault-owner-installed"],
  ["Abort", "vault-owner-written"],
  ["Abort", "vault-owner-committed"],
  ["Abort", "vault-owner-installed"],
] as const)(
  "format-2 vault %s recovers transaction death at %s",
  async (action, stage) => {
    const f = await format2Fixture(false);
    try {
      await f.accept(action === "Abort" ? "extension-lock-v2" : "accepted");
      await killed(
        f.directory,
        "upgrade-format2-vault-crash.ts",
        [
          f.repository,
          f.nextOwner.planId,
          f.nextOwner.targetBuild,
          f.owner.planId,
          f.owner.targetBuild,
          action,
          stage,
        ],
        stage
      );
      await f.run(
        retargetVaultFence(f.repository, f.nextOwner, f.owner, action)
      );
      const db = new Database(path.join(f.state, "vaults.sqlite"), {
        readonly: true,
      });
      try {
        expect(db.query("SELECT * FROM effectory_upgrade_empty").get()).toEqual(
          action === "Protect" ? f.nextOwner : f.owner
        );
      } finally {
        db.close();
      }
      if (action === "Abort") {
        writeFileSync(path.join(f.repository, "edited"), "preserve");
      }
      const result = await f.resume();
      expect(result.phase).toBe(action === "Abort" ? "Aborted" : "Complete");
    } finally {
      f.cleanup();
    }
  },
  20_000
);

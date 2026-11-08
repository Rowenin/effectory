import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";

import { readRuntimeStorage } from "../src/runtime-storage-format.ts";
import { assessRuntimeUpgrade } from "../src/upgrade-assessment.ts";
import {
  acceptRuntimeUpgrade,
  resumeRuntimeUpgrade,
} from "../src/upgrade-executor.ts";
import { makeUpgradeJournal } from "../src/upgrade-journal.ts";
import { executorTestPolicy } from "./fixtures/upgrade-executor-policy.ts";
import { format2Fixture } from "./fixtures/upgrade-format2-fixture.ts";

const stages = ["complete", "extension-lock-v2", "abort"];

test.each(
  stages.flatMap((stage) =>
    [false, true].map((vault) => [stage, vault] as const)
  )
)(
  "storage-3 owner transfer %s preserves receipts and vault (real vault: %s)",
  async (stage, realVault) => {
    const f = await format2Fixture(realVault);
    try {
      await f.run(acceptRuntimeUpgrade(f.repository, f.saved, f.policy));
      const predecessor = readRuntimeStorage(f.repository);
      expect(predecessor?.format).toBe(3);
      const priorReceipt = readFileSync(
        path.join(f.state, "upgrade-history", `${f.saved.plan.planId}.json`)
      );
      const policy = executorTestPolicy({
        ...f.saved.plan,
        source: {
          ...f.saved.plan.source,
          build: f.saved.plan.target.build,
          storage: 3,
        },
        target: { ...f.saved.plan.target, build: "d".repeat(64) },
      });
      const saved = await f.run(
        Effect.gen(function* () {
          const journal = yield* makeUpgradeJournal(f.repository);
          return yield* journal.savePlan(
            yield* assessRuntimeUpgrade(
              f.repository,
              crypto.randomUUID(),
              policy
            )
          );
        })
      );
      const resume = async () =>
        await f.run(
          Effect.gen(function* () {
            const journal = yield* makeUpgradeJournal(f.repository);
            const record = yield* journal.inspect(saved.plan.planId);
            if (record._tag !== "Accepted") {
              throw new Error("Expected accepted transfer");
            }
            return yield* resumeRuntimeUpgrade(
              f.repository,
              record.transition,
              policy
            );
          })
        );
      expect(saved.plan.status).toBe("Ready");
      expect(saved.plan.source.storage).toBe(3);
      if (stage !== "complete") {
        await f.run(
          acceptRuntimeUpgrade(f.repository, saved, policy, (name) =>
            name === "accepted" ? Effect.die("stop before resume") : Effect.void
          ).pipe(Effect.exit)
        );
        const child = Bun.spawn(
          [
            process.execPath,
            path.join(import.meta.dir, "fixtures/upgrade-executor-crash.ts"),
            f.repository,
            saved.plan.planId,
            "extension-lock-v2",
          ],
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
          expect(
            readFileSync(path.join(f.directory, "checkpoint"), "utf-8")
          ).toBe("extension-lock-v2");
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null) {
            child.kill("SIGKILL");
            await child.exited;
          }
        }
        if (stage === "abort") {
          writeFileSync(path.join(f.repository, "operator-edit"), "preserve");
        }
      }
      const result =
        stage === "complete"
          ? await f.run(acceptRuntimeUpgrade(f.repository, saved, policy))
          : await resume();
      expect(result.phase).toBe(stage === "abort" ? "Aborted" : "Complete");
      expect(readRuntimeStorage(f.repository)?.targetBuild).toBe(
        stage === "abort" ? predecessor?.targetBuild : saved.plan.target.build
      );
      expect(
        readFileSync(
          path.join(f.state, "upgrade-history", `${f.saved.plan.planId}.json`)
        )
      ).toEqual(priorReceipt);
      const db = new Database(path.join(f.state, "vaults.sqlite"), {
        readonly: true,
      });
      try {
        expect(db.query("PRAGMA user_version").get()).toEqual({
          user_version: 2,
        });
        if (!realVault) {
          expect(
            db.query("SELECT * FROM effectory_upgrade_empty").get()
          ).toEqual({
            planId: stage === "abort" ? predecessor?.planId : saved.plan.planId,
            targetBuild:
              stage === "abort"
                ? predecessor?.targetBuild
                : saved.plan.target.build,
          });
        }
      } finally {
        db.close();
      }
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
      if (stage === "abort") {
        expect(
          readFileSync(path.join(f.repository, "operator-edit"), "utf-8")
        ).toBe("preserve");
      }
      expect(await resume()).toEqual(result);
    } finally {
      f.cleanup();
    }
  },
  20_000
);

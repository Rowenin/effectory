import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import path from "node:path";

import { Effect } from "effect";

import { createStore } from "../src/host-store.ts";
import { readStoredCredentials } from "../src/runtime-storage-format.ts";
import { assessRuntimeUpgrade } from "../src/upgrade-assessment.ts";
import { createUpgradeRecoveryCopy } from "../src/upgrade-copy.ts";
import {
  acceptRuntimeUpgrade,
  resumeRuntimeUpgrade,
} from "../src/upgrade-executor.ts";
import { fileFence } from "../src/upgrade-file-fence.ts";
import { fingerprintUpgradeRepository } from "../src/upgrade-fingerprint.ts";
import { makeUpgradeJournal } from "../src/upgrade-journal.ts";
import { vaultFence } from "../src/upgrade-vault-fence.ts";
import { executorTestPolicy } from "./fixtures/upgrade-executor-policy.ts";
import { fenceFixture } from "./fixtures/upgrade-fence-fixture.ts";

function accept(f: ReturnType<typeof fenceFixture>) {
  return f.run(
    Effect.gen(function* () {
      const before = yield* fingerprintUpgradeRepository(f.repository);
      const journal = yield* makeUpgradeJournal(f.repository);
      const saved = yield* journal.savePlan({
        ...f.plan,
        source: {
          ...f.plan.source,
          dependencies: before.dependencies,
          identity: before.identity,
        },
      });
      const copy = yield* createUpgradeRecoveryCopy(
        f.repository,
        f.plan.recoveryCopy,
        f.plan.planId
      );
      return yield* journal.accept(
        {
          planDigest: saved.digest,
          planId: f.plan.planId,
          recoveryDigest: copy.digest,
          sourceIdentity: before.identity,
          targetBuild: f.owner.targetBuild,
        },
        2
      );
    })
  );
}
const resume = (f: ReturnType<typeof fenceFixture>) =>
  f.run(
    Effect.gen(function* () {
      const j = yield* makeUpgradeJournal(f.repository);
      const saved = yield* j.inspect(f.plan.planId);
      if (saved._tag !== "Accepted") {
        throw new Error("Expected accepted fixture");
      }
      return yield* resumeRuntimeUpgrade(
        f.repository,
        saved.transition,
        executorTestPolicy(saved.transition.plan)
      );
    })
  );

test("ordered executor publishes readable fenced storage and repeats its receipt before checking the recovery copy", async () => {
  const f = fenceFixture();
  try {
    f.seed();
    await accept(f);
    const result = await resume(f);
    expect(result.phase).toBe("Complete");
    expect(result.completedSteps).toEqual(f.plan.migrations);
    expect(readStoredCredentials(f.repository).token).toBe(
      "CANARY-fence-fixture"
    );
    rmSync(f.plan.recoveryCopy, { force: true, recursive: true });
    expect(await resume(f)).toEqual(result);
    const store = f.vault();
    try {
      expect(store.reveal("credentials", "token")).toBe("CANARY-fence-fixture");
    } finally {
      store.close();
    }
  } finally {
    f.cleanup();
  }
});

test("a changed source aborts accepted protection without rolling back dependency edits", async () => {
  const f = fenceFixture();
  try {
    writeFileSync(path.join(f.repository, "package.json"), '{"version":"old"}');
    await accept(f);
    await f.run(fileFence(f.repository, "Credentials", f.owner, "Protect"));
    writeFileSync(path.join(f.repository, "package.json"), '{"version":"new"}');
    const receipt = await resume(f);
    expect(receipt.phase).toBe("Aborted");
    expect(receipt.abortReason).toBe("SourceChanged");
    expect(readFileSync(path.join(f.repository, "package.json"), "utf-8")).toBe(
      '{"version":"new"}'
    );
    expect(readFileSync(path.join(f.state, "credentials.json"), "utf-8")).toBe(
      f.credentials
    );
    expect(await resume(f)).toEqual(receipt);
  } finally {
    f.cleanup();
  }
});

test.each([
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
])(
  "accepted executor resumes process death at %s",
  async (stage) => {
    const f = fenceFixture();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await accept(f);
      if (stage.startsWith("abort/")) {
        await f.run(fileFence(f.repository, "Credentials", f.owner, "Protect"));
        await f.run(vaultFence(f.repository, f.owner, "Protect", false));
        await f.run(fileFence(f.repository, "Extensions", f.owner, "Protect"));
        writeFileSync(path.join(f.repository, "edited"), "preserve");
      }
      const spawned = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "fixtures/upgrade-executor-crash.ts"),
          f.repository,
          f.plan.planId,
          stage,
        ],
        { stderr: "pipe", stdout: "pipe" }
      );
      child = spawned;
      timer = setTimeout(() => child?.kill("SIGKILL"), 10_000);
      const [code, stderr] = await Promise.all([
        spawned.exited,
        new Response(spawned.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(137);
      expect(readFileSync(path.join(f.directory, "checkpoint"), "utf-8")).toBe(
        stage
      );
      const receipt = await resume(f);
      expect(receipt.phase).toBe(
        stage.startsWith("abort/") ? "Aborted" : "Complete"
      );
      expect(readStoredCredentials(f.repository).token).toBe(
        "CANARY-fence-fixture"
      );
      expect(await resume(f)).toEqual(receipt);
    } finally {
      clearTimeout(timer);
      if (child?.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      f.cleanup();
    }
  },
  20_000
);

test("acceptance recomputes the plan and reuses a verified pre-acceptance copy without losing pending work", async () => {
  const f = fenceFixture();
  const source =
    "throw new Error('OFFLINE UPGRADE MUST NOT IMPORT APPLICATION')";
  const digest = createHash("sha256").update(source).digest("hex");
  const build = "a".repeat(64);
  const revision = createHash("sha256")
    .update(`${build}/${digest}`)
    .digest("hex");
  const directory = path.join(f.state, "revisions", revision);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "application.mjs"), source);
  writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      digest,
      effectVersion: "4.0.5",
      extensionDigests: [],
      format: 2,
      hostAbi: build,
    })
  );
  const db = new Database(path.join(f.state, "state.sqlite"));
  const store = createStore(db, {
    assertActive() {
      /* Isolated fixture. */
    },
    token: "fixture",
  });
  try {
    const pending = await Effect.runPromise(
      store.submit(
        {
          input: { preserved: true },
          kind: "task",
          requestKey: "pending",
          targetId: "unexecuted",
        },
        revision,
        "owner"
      )
    );
    db.close();
    const policy = executorTestPolicy({
      ...f.plan,
      revisions: [
        {
          disposition: "Executable",
          execution: { build, contract: null, effect: "4.0.5" },
          revision,
        },
      ],
    });
    const saved = await f.run(
      Effect.gen(function* () {
        const plan = yield* assessRuntimeUpgrade(
          f.repository,
          f.owner.planId,
          policy
        );
        expect(plan.status).toBe("Ready");
        const journal = yield* makeUpgradeJournal(f.repository);
        return yield* journal.savePlan(plan);
      })
    );
    const interrupted = await f.run(
      acceptRuntimeUpgrade(f.repository, saved, policy, (name) =>
        name === "copy-verified"
          ? Effect.die("stop before acceptance")
          : Effect.void
      ).pipe(Effect.exit)
    );
    expect(interrupted._tag).toBe("Failure");
    expect(existsSync(path.join(f.state, "upgrades/active.json"))).toBe(false);
    expect(
      existsSync(path.join(saved.plan.recoveryCopy, "manifest.json"))
    ).toBe(true);
    const completed = await f.run(
      acceptRuntimeUpgrade(f.repository, saved, policy)
    );
    expect(completed.phase).toBe("Complete");
    const reopened = new Database(path.join(f.state, "state.sqlite"));
    try {
      const after = createStore(reopened, {
        assertActive() {
          /* Isolated fixture. */
        },
        token: "fixture",
      });
      const run = await Effect.runPromise(after.getRun(pending.runId));
      expect(run.status).toBe("Queued");
      expect(run.input).toEqual({ preserved: true });
      expect(run.revision).toBe(revision);
      const receipt = await Effect.runPromise(
        after.submit(
          {
            input: { preserved: true },
            kind: "task",
            requestKey: "pending",
            targetId: "unexecuted",
          },
          revision,
          "owner"
        )
      );
      expect(receipt.runId).toBe(pending.runId);
    } finally {
      reopened.close();
    }
  } finally {
    db.close();
    f.cleanup();
  }
});

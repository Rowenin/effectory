/* oxlint-disable no-await-in-loop -- Observe a subprocess crash barrier before sending SIGKILL. */
import { expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { ownershipLayer } from "../src/ownership.ts";
import { makeUpgradeJournal } from "../src/upgrade-journal.ts";
import type { UpgradePlan } from "../src/upgrade-record.ts";
import { assertUpgradeIdle } from "../src/upgrade-transition-gate.ts";

const build = "b".repeat(64);
const identity = "a".repeat(64);
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "effectory-upgrade-journal-"));
  const state = path.join(root, ".effectory");
  mkdirSync(state);
  const plan: typeof UpgradePlan.Type = {
    blockers: [],
    createdAt: 100,
    expiresAt: 200,
    format: 1,
    migrations: ["credentials", "vault", "extensions", "metadata"],
    planId: crypto.randomUUID(),
    recoveryCopy: path.join(root, "copy"),
    repositoryId: "test",
    revisions: [],
    source: { build: identity, dependencies: identity, identity, storage: 1 },
    status: "Ready",
    target: { build, contract: "test/v1", effect: "4.0.5", storage: 2 },
    work: {},
    workByRevision: [],
  };
  const run = <A, E>(
    body: (
      journal: Effect.Success<ReturnType<typeof makeUpgradeJournal>>
    ) => Effect.Effect<A, E>
  ) =>
    Effect.runPromise(
      makeUpgradeJournal(root).pipe(
        Effect.flatMap(body),
        Effect.provide(ownershipLayer(path.join(state, "state.sqlite.owner")))
      )
    );
  const accept = (digest: string) => ({
    planDigest: digest,
    planId: plan.planId,
    recoveryDigest: identity,
    sourceIdentity: identity,
    targetBuild: build,
  });
  return { accept, plan, root, run, state };
}

test("upgrade acceptance precedes freshness checks and terminal receipts never change", async () => {
  const f = fixture();
  try {
    const saved = await f.run((j) => j.savePlan(f.plan));
    await expect(
      f.run((j) => j.accept(f.accept(saved.digest), 201))
    ).rejects.toMatchObject({ code: "Conflict" });
    const accepted = await f.run((j) => j.accept(f.accept(saved.digest), 150));
    expect(() => assertUpgradeIdle(f.root)).toThrow(f.plan.planId);
    expect(
      await f.run((j) =>
        j.accept(
          { ...f.accept("c".repeat(64)), sourceIdentity: "d".repeat(64) },
          999
        )
      )
    ).toEqual(accepted);
    await expect(
      f.run((j) =>
        j.checkpoint(f.plan.planId, build, { phase: "Complete" }, 151)
      )
    ).rejects.toMatchObject({ code: "Conflict" });
    await expect(
      f.run((j) =>
        j.checkpoint(f.plan.planId, build, { completedStep: "vault" }, 151)
      )
    ).rejects.toMatchObject({ code: "Conflict" });
    await f.run((j) =>
      j.checkpoint(f.plan.planId, build, { phase: "Aborting" }, 151)
    );
    const receipt = await f.run((j) =>
      j.checkpoint(f.plan.planId, build, { phase: "Aborted" }, 152)
    );
    const filename = path.join(
      f.state,
      "upgrade-history",
      `${f.plan.planId}.json`
    );
    const bytes = readFileSync(filename);
    await f.run((j) => j.release(f.plan.planId, build));
    assertUpgradeIdle(f.root);
    expect(
      await f.run((j) =>
        j.accept(
          { ...f.accept(saved.digest), targetBuild: "e".repeat(64) },
          999
        )
      )
    ).toEqual(receipt);
    expect(
      await f.run((j) => j.checkpoint(f.plan.planId, build, {}, 1000))
    ).toEqual(receipt);
    expect(readFileSync(filename)).toEqual(bytes);
    expect(
      existsSync(
        path.join(f.state, "upgrades", "plans", `${f.plan.planId}.json`)
      )
    ).toBe(false);
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

test("upgrade journal rejects corrupted history and substituted prepare files without touching linked data", async () => {
  const f = fixture();
  try {
    const saved = await f.run((j) => j.savePlan(f.plan));
    const victim = path.join(f.root, "victim");
    writeFileSync(victim, "preserve");
    const prepare = path.join(f.state, "upgrades", "active.json.prepare");
    linkSync(victim, prepare);
    await expect(
      f.run((j) => j.accept(f.accept(saved.digest), 150))
    ).rejects.toMatchObject({ code: "RevisionUnavailable" });
    expect(readFileSync(victim, "utf-8")).toBe("preserve");
    rmSync(prepare);
    await f.run((j) => j.accept(f.accept(saved.digest), 150));
    const filename = path.join(
      f.state,
      "upgrade-history",
      `${f.plan.planId}.json`
    );
    const record = JSON.parse(readFileSync(filename, "utf-8"));
    record.plan.source.identity = "c".repeat(64);
    writeFileSync(filename, JSON.stringify(record));
    await expect(f.run((j) => j.inspect(f.plan.planId))).rejects.toMatchObject({
      code: "RevisionUnavailable",
    });
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

test.each(["accepted", "history-published", "complete", "released"])(
  "upgrade journal survives SIGKILL at %s",
  async (stage) => {
    const f = fixture();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const saved = await f.run((j) => j.savePlan(f.plan));
      const marker = path.join(f.root, "barrier");
      child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "fixtures", "upgrade-journal-worker.ts"),
          f.root,
          f.plan.planId,
          saved.digest,
          stage,
          marker,
        ],
        { stderr: "pipe", stdout: "pipe" }
      );
      const deadline = Date.now() + 10_000;
      while (
        !existsSync(marker) &&
        Date.now() < deadline &&
        child.exitCode === null
      ) {
        await Bun.sleep(10);
      }
      expect(existsSync(marker)).toBe(true);
      child.kill("SIGKILL");
      await child.exited;
      const inspected = await f.run((j) => j.inspect(f.plan.planId));
      expect(inspected._tag).toBe("Accepted");
      if (inspected._tag !== "Accepted") {
        throw new Error("Lost acceptance");
      }
      expect(inspected.transition.acceptance.acceptedAt).toBe(150);
      expect(inspected.transition.phase).toBe(
        stage === "complete" || stage === "released" ? "Complete" : "Protecting"
      );
      if (stage !== "released") {
        expect(() => assertUpgradeIdle(f.root)).toThrow(f.plan.planId);
      }
      expect(await f.run((j) => j.accept(f.accept(saved.digest), 500))).toEqual(
        inspected.transition
      );
      if (inspected.transition.phase === "Complete") {
        await f.run((j) => j.release(f.plan.planId, build));
        assertUpgradeIdle(f.root);
      } else {
        await expect(
          f.run((j) => j.release(f.plan.planId, build))
        ).rejects.toMatchObject({ code: "Conflict" });
        await expect(
          f.run((j) =>
            j.accept({ ...f.accept(saved.digest), targetBuild: identity }, 500)
          )
        ).rejects.toMatchObject({ code: "RevisionUnavailable" });
      }
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      rmSync(f.root, { force: true, recursive: true });
    }
  },
  15_000
);

test("completed upgrade cleanup cannot remove a later transition, and released ownership cannot write", async () => {
  const f = fixture();
  try {
    const saved = await f.run((j) => j.savePlan(f.plan));
    await f.run((j) => j.accept(f.accept(saved.digest), 150));
    await f.run((j) =>
      j.checkpoint(f.plan.planId, build, { phase: "Aborting" }, 151)
    );
    await f.run((j) =>
      j.checkpoint(f.plan.planId, build, { phase: "Aborted" }, 152)
    );
    await f.run((j) => j.release(f.plan.planId, build));
    const second = { ...f.plan, planId: crypto.randomUUID() };
    const next = await f.run((j) => j.savePlan(second));
    await f.run((j) =>
      j.accept({ ...f.accept(next.digest), planId: second.planId }, 153)
    );
    await f.run((j) => j.release(f.plan.planId, build));
    expect(() => assertUpgradeIdle(f.root)).toThrow(second.planId);
    const escaped = await f.run((j) => Effect.succeed(j));
    await expect(
      Effect.runPromise(
        escaped.checkpoint(second.planId, build, { phase: "Aborting" }, 154)
      )
    ).rejects.toMatchObject({ code: "Unavailable" });
    const current = await f.run((j) => j.inspect(second.planId));
    expect(current._tag === "Accepted" && current.transition.phase).toBe(
      "Protecting"
    );
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

test("an oversized upgrade plan leaves no control directory or partial preview", async () => {
  const f = fixture();
  try {
    const expanded = {
      ...f.plan,
      workByRevision: Array.from({ length: 128 }, (_, index) => ({
        counts: {
          reportCancellations: 0,
          reportSources: 0,
          reports: 0,
          runs: 20,
          scheduledAdmissions: 0,
        },
        examples: Array.from({ length: 20 }, () => ({
          category: "runs",
          id: "x".repeat(4096),
        })),
        examplesTruncated: false,
        revision: String(index),
      })),
    };
    await expect(f.run((j) => j.savePlan(expanded))).rejects.toMatchObject({
      code: "LimitExceeded",
    });
    expect(existsSync(path.join(f.state, "upgrades"))).toBe(false);
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

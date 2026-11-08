import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { createStore } from "../src/host-store.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { runtimeUpgrade } from "../src/upgrade-commands.ts";
import { fingerprintUpgradeRepository } from "../src/upgrade-fingerprint.ts";

const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const main = path.resolve(import.meta.dir, "../../cli/src/main.ts");
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "effectory-upgrade-commands-"));
  const repository = path.join(root, "repo");
  const state = path.join(repository, ".effectory");
  const build = "a".repeat(64);
  const application = "throw new Error('UPGRADE MUST NOT IMPORT APPLICATION')";
  const digest = hash(application);
  const revision = hash(`${build}/${digest}`);
  const directory = path.join(state, "revisions", revision);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "application.mjs"), application);
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
  writeFileSync(path.join(repository, "effectory.ts"), application);
  writeFileSync(
    path.join(repository, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.1.0" })
  );
  writeFileSync(
    path.join(state, "credentials.json"),
    JSON.stringify({
      repositoryId: "fixture",
      token: "CANARY-UPGRADE-CREDENTIAL",
    })
  );
  const filename = path.join(state, "state.sqlite");
  const db = new Database(filename);
  const store = createStore(db, { assertActive() {}, token: "fixture" });
  const run = Effect.runSync(
    store.submit(
      { input: null, kind: "workflow", requestKey: "first", targetId: "work" },
      revision,
      "owner"
    )
  );
  db.close();
  return { build, filename, repository, revision, root, run, state };
}
async function cli(repository: string, args: readonly string[]) {
  const child = Bun.spawn(
    [process.execPath, main, ...args, "--repository", repository, "--json"],
    { stderr: "pipe", stdout: "pipe" }
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(child.signalCode).toBe(null);
    return { code, stderr, stdout };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}
function bytes(repository: string) {
  const output: Record<string, string> = {};
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop();
    if (relative === undefined) {
      break;
    }
    for (const entry of readdirSync(path.join(repository, relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, entry.name);
      if (
        name.startsWith(".effectory/state.sqlite.owner") ||
        name.startsWith(".effectory/upgrades")
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(name);
      } else {
        output[name] = hash(readFileSync(path.join(repository, name)));
      }
    }
  }
  return output;
}

test("offline CLI plans and inspects without application loading or runtime mutation; uncertified apply refuses", async () => {
  const f = fixture();
  try {
    const before = bytes(f.repository);
    const planned = await cli(f.repository, ["upgrade", "plan"]);
    expect(planned.code).toBe(0);
    expect(planned.stderr).toBe("");
    expect(planned.stdout).not.toContain("CANARY-UPGRADE-CREDENTIAL");
    const { plan, digest } = JSON.parse(planned.stdout);
    expect(plan.status).toBe("Unsupported");
    expect(plan.source.build).toBe(f.build);
    expect(plan.work["execution.runs"]).toBe(1);
    expect(plan.work["outbox.Dispatch"]).toBe(1);
    expect(plan.workByRevision[0].examples[0].id).toBe(f.run.runId);
    expect(plan.revisions[0]).toMatchObject({
      disposition: "Unavailable",
      revision: f.revision,
    });
    expect(bytes(f.repository)).toEqual(before);
    expect(existsSync(plan.recoveryCopy)).toBe(false);
    const inspected = await cli(f.repository, [
      "upgrade",
      "inspect",
      plan.planId,
    ]);
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout)).toEqual({
      _tag: "Planned",
      digest,
      plan,
    });
    const refused = await cli(f.repository, ["upgrade", "apply", plan.planId]);
    expect(refused.code).toBe(5);
    expect(refused.stderr).toContain("no applicable certified transition");
    expect(refused.stdout).toBe("");
    expect(bytes(f.repository)).toEqual(before);
    expect(existsSync(path.join(f.state, "upgrades", "active.json"))).toBe(
      false
    );
    expect(existsSync(plan.recoveryCopy)).toBe(false);
    const bare = await cli(f.repository, ["upgrade"]);
    expect(bare.code).toBe(0);
    expect(
      JSON.parse(readFileSync(path.join(f.repository, "package.json"), "utf-8"))
        .devDependencies.effect
    ).toBe("4.0.5");
    const stale = await cli(f.repository, ["upgrade", "apply", plan.planId]);
    expect(stale.code).toBe(5);
    expect(stale.stderr).toContain("Repository changed since upgrade planning");
    const invalid = await cli(f.repository, ["upgrade", "inspect", "../bad"]);
    expect(invalid.code).toBe(2);
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
}, 45_000);

test("planning rejects an active owner and unknown durable work before publishing a plan", async () => {
  const f = fixture();
  try {
    const busy = await Effect.runPromise(
      Effect.tryPromise(() => cli(f.repository, ["upgrade", "plan"])).pipe(
        Effect.provide(ownershipLayer(`${f.filename}.owner`))
      )
    );
    expect(busy.code).toBe(5);
    expect(busy.stderr).toContain("owned by another process");
    expect(existsSync(path.join(f.state, "upgrades"))).toBe(false);
    const db = new Database(f.filename);
    db.exec("UPDATE host_outbox SET kind='UnknownFutureIntent'");
    db.close();
    const before = bytes(f.repository);
    await expect(
      Effect.runPromise(runtimeUpgrade(f.repository, { kind: "Plan" }))
    ).rejects.toMatchObject({ code: "RevisionUnavailable" });
    expect(bytes(f.repository)).toEqual(before);
    expect(existsSync(path.join(f.state, "upgrades"))).toBe(false);
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
}, 15_000);

test("repository fingerprint includes dependencies, runtime rows, artifacts and earlier upgrade receipts", async () => {
  const f = fixture();
  const fingerprint = () =>
    Effect.runPromise(
      fingerprintUpgradeRepository(f.repository).pipe(
        Effect.provide(ownershipLayer(`${f.filename}.owner`))
      )
    );
  try {
    const before = await fingerprint();
    mkdirSync(path.join(f.state, "upgrades"));
    writeFileSync(
      path.join(f.state, "upgrades", "preview"),
      "temporary control"
    );
    expect(await fingerprint()).toEqual(before);
    mkdirSync(path.join(f.state, "upgrade-history"));
    writeFileSync(
      path.join(f.state, "upgrade-history", "old.json"),
      "prior receipt"
    );
    const receipt = await fingerprint();
    expect(receipt.identity).not.toBe(before.identity);
    expect(receipt.dependencies).toBe(before.dependencies);
    writeFileSync(path.join(f.repository, "bun.lock"), "new dependency state");
    const dependencies = await fingerprint();
    expect(dependencies.identity).not.toBe(receipt.identity);
    expect(dependencies.dependencies).not.toBe(receipt.dependencies);
    const db = new Database(f.filename);
    db.exec("UPDATE host_runs SET status='Waiting'");
    db.close();
    const changed = await fingerprint();
    expect(changed.identity).not.toBe(dependencies.identity);
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

test("a forged Ready preview cannot grant migration permission, and expired plans refuse before writes", async () => {
  const f = fixture();
  try {
    const result = await Effect.runPromise(
      runtimeUpgrade(f.repository, { kind: "Plan" })
    );
    if (!("plan" in result) || !("digest" in result)) {
      throw new Error("Expected a saved plan");
    }
    const planFile = path.join(
      f.state,
      "upgrades",
      "plans",
      `${result.plan.planId}.json`
    );
    const preview = { ...result.plan, blockers: [], status: "Ready" };
    writeFileSync(planFile, JSON.stringify(preview));
    const before = bytes(f.repository);
    await expect(
      Effect.runPromise(
        runtimeUpgrade(f.repository, {
          kind: "Apply",
          planId: result.plan.planId,
        })
      )
    ).rejects.toMatchObject({ code: "RevisionUnavailable" });
    expect(bytes(f.repository)).toEqual(before);
    expect(existsSync(path.join(f.state, "upgrades", "active.json"))).toBe(
      false
    );
    writeFileSync(
      planFile,
      JSON.stringify({ ...preview, createdAt: 1, expiresAt: 2 })
    );
    await expect(
      Effect.runPromise(
        runtimeUpgrade(f.repository, {
          kind: "Apply",
          planId: result.plan.planId,
        })
      )
    ).rejects.toMatchObject({ code: "Conflict" });
    expect(bytes(f.repository)).toEqual(before);
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

test.each(["runtime", "vault"] as const)(
  "planning refuses unknown %s storage versions before publishing",
  async (kind) => {
    const f = fixture();
    try {
      const db = new Database(
        kind === "runtime" ? f.filename : path.join(f.state, "vaults.sqlite")
      );
      db.exec("PRAGMA user_version=9000");
      db.close();
      const before = bytes(f.repository);
      await expect(
        Effect.runPromise(runtimeUpgrade(f.repository, { kind: "Plan" }))
      ).rejects.toMatchObject({ code: "RevisionUnavailable" });
      expect(bytes(f.repository)).toEqual(before);
      expect(existsSync(path.join(f.state, "upgrades"))).toBe(false);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }
);

/* oxlint-disable no-await-in-loop -- Each offline command must finish before the next source-byte comparison. */
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

import { Effect, Exit } from "effect";

import { recoverExtensionOperations } from "../src/extension-manager.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { acceptRuntimeUpgrade } from "../src/upgrade-executor.ts";
import { format2Fixture } from "./fixtures/upgrade-format2-fixture.ts";

const main = path.resolve(import.meta.dir, "../../cli/src/main.ts");
const planId = "f086cd4e-ad6f-4823-9777-3447372d1bf4";
const targetBuild = "b".repeat(64);
function snapshot(root: string) {
  const result: Record<string, string> = {};
  const pending = [""];
  while (pending.length) {
    const relative = pending.pop();
    if (relative === undefined) {
      break;
    }
    for (const item of readdirSync(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, item.name);
      if (name.startsWith(path.join(".effectory", "state.sqlite.owner"))) {
        continue;
      }
      if (item.isDirectory()) {
        pending.push(name);
      } else {
        result[name] = createHash("sha256")
          .update(readFileSync(path.join(root, name)))
          .digest("hex");
      }
    }
  }
  return result;
}
test("normal startup and every affected offline entry point refuse an unfinished transition before opening runtime storage", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "effectory-upgrade-writers-"));
  const repository = path.join(root, "repository");
  const state = path.join(repository, ".effectory");
  const filename = path.join(state, "state.sqlite");
  mkdirSync(path.join(state, "upgrades"), { recursive: true });
  const database = new Database(filename);
  database.exec(
    "CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('preserve')"
  );
  database.close();
  writeFileSync(
    path.join(repository, "effectory.ts"),
    "throw new Error('MUST NOT LOAD APPLICATION')"
  );
  writeFileSync(
    path.join(state, "credentials.json"),
    JSON.stringify({
      repositoryId: "upgrade-writer-proof",
      token: "synthetic-not-real",
    })
  );
  writeFileSync(
    path.join(state, "upgrades/active.json"),
    JSON.stringify({ format: 1, phase: "Protecting", planId, targetBuild })
  );
  const before = snapshot(repository);
  try {
    for (const args of [
      ["daemon", "serve"],
      [
        "run",
        "reclaim",
        "plan",
        "--completed-before",
        "2027-01-01T00:00:00.000Z",
      ],
      ["run", "reclaim", "compact"],
      ["vault", "reset", "synthetic", "--discard"],
      [
        "vault",
        "key",
        "import",
        "synthetic",
        "--file",
        path.join(root, "missing-key.json"),
      ],
      [
        "vault",
        "key",
        "export",
        "synthetic",
        "--output",
        path.join(root, "exported-key.json"),
      ],
      ["extension", "restore", "--trust"],
      ["backup", path.join(root, "snapshot")],
    ]) {
      const child = Bun.spawn(
        [process.execPath, main, ...args, "--repository", repository, "--json"],
        { stderr: "pipe", stdout: "pipe" }
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ args, code, signal: child.signalCode }).toEqual({
          args,
          code: 5,
          signal: null,
        });
        expect(stdout).toBe("");
        expect(stderr).toContain(planId);
        expect(stderr).toContain(targetBuild);
        expect(stderr).not.toContain("MUST NOT LOAD");
        expect(snapshot(repository)).toEqual(before);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await child.exited;
        }
      }
    }
    expect(existsSync(path.join(root, "snapshot"))).toBe(false);
    expect(existsSync(path.join(root, "exported-key.json"))).toBe(false);
    expect(existsSync(path.join(state, "vaults.sqlite"))).toBe(false);
    const recovered = await Effect.runPromise(
      recoverExtensionOperations(repository).pipe(
        Effect.provide(ownershipLayer(`${filename}.owner`)),
        Effect.exit
      )
    );
    expect(Exit.isFailure(recovered)).toBe(true);
    expect(snapshot(repository)).toEqual(before);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}, 150_000);

test("offline writers refuse a completed supported format owned by another build", async () => {
  const f = await format2Fixture(false);
  try {
    const receipt = await f.run(
      acceptRuntimeUpgrade(f.repository, f.saved, f.policy)
    );
    expect(receipt.phase).toBe("Complete");
    const before = snapshot(f.repository);
    for (const args of [
      ["run", "reclaim", "plan", "--completed-before", "2027-01-01T00:00:00Z"],
      ["run", "reclaim", "compact"],
      ["vault", "reset", "synthetic", "--discard"],
      [
        "vault",
        "key",
        "import",
        "synthetic",
        "--file",
        path.join(f.directory, "missing-key.json"),
      ],
      [
        "vault",
        "key",
        "export",
        "synthetic",
        "--output",
        path.join(f.directory, "exported-key.json"),
      ],
      ["extension", "restore", "--trust"],
    ]) {
      const child = Bun.spawn(
        [
          process.execPath,
          main,
          ...args,
          "--repository",
          f.repository,
          "--json",
        ],
        { stderr: "pipe", stdout: "pipe" }
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ args, code }).toEqual({ args, code: 5 });
        expect(stdout).toBe("");
        expect(stderr).toContain(f.nextOwner.targetBuild);
        expect(snapshot(f.repository)).toEqual(before);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await child.exited;
        }
      }
    }
  } finally {
    f.cleanup();
  }
}, 150_000);

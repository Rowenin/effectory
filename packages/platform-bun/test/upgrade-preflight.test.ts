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

import { digestOf } from "../src/application-bundle.ts";
import { createStore } from "../src/host-store.ts";
import { effectory } from "./fixtures/cli.ts";

function snapshot(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (location: string, prefix: string) => {
    for (const entry of readdirSync(location, { withFileTypes: true })) {
      if (entry.name.startsWith("state.sqlite.owner")) {
        continue;
      }
      const name = path.join(prefix, entry.name);
      const filename = path.join(location, entry.name);
      if (entry.isDirectory()) {
        result[name] = "directory";
        visit(filename, name);
      } else {
        result[name] = createHash("sha256")
          .update(readFileSync(filename))
          .digest("hex");
      }
    }
  };
  visit(directory, "");
  return result;
}

test.each([
  "legacy-build",
  "uncertified-contract",
  "late-intent",
  "orphan-intent",
  "recovery-format",
] as const)(
  "daemon rejects %s before credentials, recovery, or application code can mutate state",
  async (fault) => {
    const repository = mkdtempSync(
      path.join(tmpdir(), "effectory-upgrade-preflight-")
    );
    const directory = path.join(repository, ".effectory");
    mkdirSync(directory);
    const database = new Database(path.join(directory, "state.sqlite"));
    try {
      const store = createStore(database, {
        assertActive: () => {},
        token: "fixture",
      });
      const run = Effect.runSync(
        store.submit(
          { input: {}, kind: "task", requestKey: "pending", targetId: "task" },
          "revision",
          "owner"
        )
      );
      if (fault === "legacy-build" || fault === "uncertified-contract") {
        const source =
          "throw new Error('This historical application must never execute');";
        const manifest = {
          digest: digestOf(source),
          effectVersion: "4.0.5",
          extensionDigests: [],
          format: fault === "legacy-build" ? 2 : 3,
          hostAbi: "a".repeat(64),
          ...(fault === "uncertified-contract"
            ? { executionContract: "effectory.execution/v1" }
            : {}),
        };
        const revision = digestOf(`${manifest.hostAbi}/${manifest.digest}`);
        const retained = path.join(directory, "revisions", revision);
        mkdirSync(retained, { recursive: true });
        writeFileSync(path.join(retained, "application.mjs"), source);
        writeFileSync(
          path.join(retained, "manifest.json"),
          JSON.stringify(manifest)
        );
        // Catalog used to delete this before it noticed the incompatible revision.
        mkdirSync(path.join(directory, "revisions", "b".repeat(64)));
      }
      if (fault === "late-intent" || fault === "orphan-intent") {
        database
          .query(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<450)
        INSERT INTO host_outbox(kind,runId,waitId,intentKey,delivered) SELECT 'Dispatch',?,NULL,'extra/'||x,0 FROM n`)
          .run(run.runId);
        if (fault === "late-intent") {
          database.run(
            "UPDATE host_outbox SET kind='FutureIntent' WHERE id=451"
          );
        } else {
          database.run("PRAGMA foreign_keys=OFF");
          database.run("UPDATE host_outbox SET runId='missing' WHERE id=451");
        }
      }
      if (fault === "recovery-format") {
        database.run("DROP TABLE host_attempt_windows");
      }
    } finally {
      database.close();
    }
    try {
      const before = snapshot(repository);
      const child = Bun.spawn(
        [...effectory, "daemon", "serve", "--repository", repository],
        { stderr: "pipe", stdout: "pipe" }
      );
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try {
        const [code, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
          new Response(child.stdout).text(),
        ]);
        expect(child.signalCode, stderr).toBeNull();
        expect(code, stderr).toBe(5);
        expect(stderr).toContain(
          fault === "legacy-build" ? "legacy host build" : "compatible host"
        );
        expect(existsSync(path.join(directory, "credentials.json"))).toBe(
          false
        );
        expect(existsSync(path.join(directory, "daemon.json"))).toBe(false);
        expect(snapshot(repository)).toEqual(before);
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await child.exited;
        }
      }
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  },
  25_000
);

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { terminal } from "@effectory/runtime/protocol";
import { Effect } from "effect";

import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { leafExecution } from "../src/interpreter.ts";
import {
  normalizeInvocation,
  outputFields,
} from "../src/invocation-outcome.ts";
import { nativeHistoryLayer, nativeTaskResult } from "../src/native-history.ts";
import { revisionCatalogLayer } from "../src/revisions.ts";
import { Runner } from "../src/runner.ts";

function snapshot(filename: string) {
  return Object.fromEntries(
    ["", "-wal", "-shm"].map((suffix) => [
      suffix,
      existsSync(filename + suffix)
        ? createHash("sha256")
            .update(readFileSync(filename + suffix))
            .digest("hex")
        : null,
    ])
  );
}

test("stored task outcomes are readable in a fresh process without application code, migrations or an engine", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-native-history-")
  );
  const state = path.join(repository, ".effectory");
  const filename = path.join(state, "state.sqlite");
  const audit = path.join(repository, "executions.txt");
  const imported = path.join(repository, "forbidden-import.txt");
  await mkdir(state);
  await writeFile(
    path.join(repository, "effectory.ts"),
    `
import { appendFileSync } from "node:fs";
import { Application, Task } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";
const work = Task.make({ id: "history", version: 1, input: Schema.Literals(["ok", "domain", "defect"]), success: Schema.String,
 error: Schema.Struct({ _tag: Schema.Literal("DomainFailure"), message: Schema.String }), replay: "idempotent" }, (mode) => Effect.gen(function* () {
 yield* Effect.sync(() => appendFileSync(${JSON.stringify(audit)}, mode + "\\n"));
 if (mode === "domain") return yield* Effect.fail({ _tag: "DomainFailure", message: "expected failure" });
 if (mode === "defect") return yield* Effect.die(new Error("expected defect"));
 return "stored success";
}));
export default Application.make({ tasks: [work] });
`
  );
  try {
    const captured = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* Runner;
        const store = yield* HostStore;
        const rows = [];
        for (const mode of ["ok", "domain", "defect"] as const) {
          const run = yield* runner.submit(
            {
              input: mode,
              kind: "task",
              requestKey: mode,
              targetId: "history",
            },
            "owner"
          );
          while (!terminal.has((yield* store.getRun(run.runId)).status)) {
            yield* Effect.sleep("10 millis");
          }
          const page = yield* store.invocationScan(
            { runId: run.runId },
            "owner"
          );
          const [invocation] = page.rows;
          if (!invocation) {
            return yield* Effect.die("Missing native invocation");
          }
          const native = yield* leafExecution.poll(invocation.engineId);
          rows.push({
            id: invocation.engineId,
            result: outputFields(
              normalizeInvocation(native, {
                fenced: false,
                reason: null,
                status: "Succeeded",
              })
            ),
          });
        }
        return rows;
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.scoped,
        Effect.provide(
          hostLayer({
            blobs: path.join(state, "blobs"),
            catalog: revisionCatalogLayer(repository),
            database: filename,
          })
        )
      )
    );
    expect(captured.map((row) => row.result.status)).toEqual([
      "Succeeded",
      "Failed",
      "Failed",
    ]);
    const before = snapshot(filename);
    const beforeAudit = await readFile(audit, "utf-8");
    const trap = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(imported)}, "imported"); throw new Error("Must not import historical code");`;
    await writeFile(path.join(repository, "effectory.ts"), trap);
    await Promise.all(
      readdirSync(path.join(state, "revisions")).map(
        async (revision) =>
          await writeFile(
            path.join(state, "revisions", revision, "application.mjs"),
            trap
          )
      )
    );
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "fixtures/native-history-read.ts"),
        repository,
        JSON.stringify(captured.map((row) => row.id)),
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      expect(child.signalCode).toBeNull();
      expect(JSON.parse(stdout)).toEqual(captured.map((row) => row.result));
      expect(existsSync(imported)).toBe(false);
      expect(await readFile(audit, "utf-8")).toBe(beforeAudit);
      expect(snapshot(filename)).toEqual(before);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
    const [first] = captured;
    if (!first) {
      throw new Error("Missing successful native history");
    }
    // Corrupt only disposable, checkpointed copies. Neither a malformed codec
    // nor JSON parsing may return success or expose raw stored error text.
    await Promise.all(
      [
        ["json", "CANARY-invalid-json"],
        [
          "codec",
          JSON.stringify({ _tag: "UnknownExit", secret: "CANARY-codec" }),
        ],
        ["oversized", "x".repeat(16_777_217)],
        ["unknown-kind", "CANARY-unknown-frame"],
        ["integer-kind", "7"],
        ["large-header", "x".repeat(16_777_217)],
        ["exit-sequence", "0"],
      ].map(async ([label, payload]) => {
        const copy = path.join(repository, `${label}.sqlite`);
        await Promise.all(
          ["", "-wal", "-shm"]
            .filter((suffix) => existsSync(filename + suffix))
            .map(
              async (suffix) => await copyFile(filename + suffix, copy + suffix)
            )
        );
        const database = new Database(copy);
        // Host-owned column names only. Unknown headers must fail before the
        // Effect decoder turns them into a Chunk / an apparently absent result.
        let column = "payload";
        if (label === "unknown-kind" || label === "integer-kind") {
          column = "kind";
        } else if (label === "large-header" || label === "exit-sequence") {
          column = "sequence";
        }
        try {
          database
            .query(
              `UPDATE cluster_replies SET ${column}=? WHERE rowid=(SELECT MIN(rowid) FROM cluster_replies WHERE request_id=(SELECT id FROM cluster_messages WHERE entity_id=? AND tag='run'))`
            )
            .run(payload ?? "", first.id);
        } finally {
          database.close();
        }
        const failure = await Effect.runPromise(
          nativeTaskResult(first.id).pipe(
            Effect.flip,
            Effect.provide(nativeHistoryLayer(copy))
          )
        );
        expect(failure.code).toBe("RevisionUnavailable");
        expect(failure.message).not.toContain("CANARY");
      })
    );
    expect(snapshot(filename)).toEqual(before);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
}, 40_000);

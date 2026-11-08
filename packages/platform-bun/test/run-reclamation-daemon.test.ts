/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Process readiness and state transitions are checked sequentially. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Run } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { approval, cli, effectory, start } from "./fixtures/cli.ts";

const application = `
import { Application, Artifact, ArtifactStorage, AssertionFailed, Checks, Report, Task, Workflow } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";
const Value=Artifact.make({id:"value",version:1,schema:Schema.Int,retention:{maxVersions:1}});
const Bytes=Artifact.make({id:"bytes",version:1,kind:"bytes",contentType:"application/octet-stream"});
const Produce=Task.make({id:"produce",version:1,input:Schema.Null,success:Schema.Int,error:AssertionFailed,replay:"idempotent",outputs:{value:Value,bytes:Bytes}},(_,ctx)=>Effect.gen(function*(){
 yield* (yield* Checks).assert("ready",Effect.succeed(ctx.attempt>1),{message:"Retry once"});
 const storage=yield* ArtifactStorage;yield* storage.publish(Value,42,{key:"value"});yield* storage.publish(Bytes,new Uint8Array([1,2,3]),{key:"bytes"});return 42;
}));
const Child=Workflow.make({id:"child",version:1,input:Schema.Null,success:Schema.Int,error:AssertionFailed},Effect.gen(function*(){const g=yield* Workflow.Builder;return yield* g.task("produce",Produce,null,{retry:{attempts:2,delay:"20 millis",when:["AssertionFailed"]}});}));
const Root=Workflow.make({id:"root",version:1,input:Schema.Null,success:Schema.Int,error:AssertionFailed},Effect.gen(function*(){const g=yield* Workflow.Builder;yield* g.sleep("timer","40 millis");return yield* g.workflow("child",Child,null);}));
const Waiting=Workflow.make({id:"waiting",version:1,input:Schema.Null,success:Schema.Boolean,error:Schema.Never},Effect.gen(function*(){yield* (yield* Workflow.Builder).approval("gate",{prompt:"Keep this run",timeout:"1 hour"});return true;}));
const Summary=Task.make({id:"summary",version:1,input:Report.Source,success:Report.result(Schema.Json),error:Schema.Never,replay:"idempotent"},()=>Effect.gen(function*(){const history=yield* Report.History;const events=yield* history.events();return {markdown:"Report to retire",data:{events:events.items.length}};}));
export default Application.make({tasks:[Produce,Summary],workflows:[Root,Waiting],reports:[Report.make({id:"root-summary",target:Root,task:Summary}),Report.make({id:"child-summary",target:Child,scope:"invocation",task:Summary}),Report.make({id:"task-summary",target:Produce,scope:"invocation",task:Summary})]});
`;
const Plan = Schema.Struct({
  families: Schema.Array(
    Schema.Struct({ runs: Schema.Int, sourceRunId: Schema.String })
  ),
  planId: Schema.String,
});
async function raw(repository: string, args: string[]) {
  const proc = Bun.spawn(
    [...effectory, ...args, "--repository", repository, "--json"],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stderr, stdout };
}
async function reportsDone(repository: string, runId: string) {
  for (let n = 0; n < 100; n += 1) {
    const db = new Database(path.join(repository, ".effectory/state.sqlite"));
    const count = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) count FROM host_reports r JOIN host_report_groups g ON g.groupId=r.groupId WHERE g.sourceRunId=? AND r.status!='Succeeded'"
      )
      .get(runId)?.count;
    db.close();
    if (count === 0) {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error("Reports did not settle");
}

test("real daemon retirement preserves another wait, native cleanup, artifacts, receipts and offline restore", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-history-cli-")
  );
  const repository = path.join(directory, "repo");
  await mkdir(repository);
  const children: Awaited<ReturnType<typeof start>>[] = [];
  try {
    await writeFile(path.join(repository, "effectory.ts"), application);
    const first = await start(repository);
    children.push(first);
    const completed = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "workflow",
        "run",
        "root",
        "--input",
        "null",
        "--request-key",
        "completed",
      ])
    );
    expect(completed.status).toBe("Succeeded");
    await reportsDone(repository, completed.runId);
    const waiting = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "workflow",
        "run",
        "waiting",
        "--input",
        "null",
        "--background",
      ])
    );
    const wait = await approval(repository, waiting.runId);
    expect(
      (
        await raw(repository, [
          "run",
          "reclaim",
          "plan",
          "--run",
          completed.runId,
        ])
      ).code
    ).not.toBe(0);
    await cli(repository, ["daemon", "stop"]);
    await first.exited;
    const db = new Database(path.join(repository, ".effectory/state.sqlite"));
    const identities = db
      .query<{ engineId: string }, [string, string]>(
        "SELECT engineId FROM host_runs WHERE runId=? UNION SELECT engineId FROM host_invocations WHERE runId=?"
      )
      .all(completed.runId, completed.runId);
    const artifact = db
      .query<{ artifactId: string; version: number }, [string]>(
        "SELECT artifactId,version FROM lake_records WHERE schemaId=? LIMIT 1"
      )
      .get("bytes");
    expect(artifact).not.toBeNull();
    db.close();
    const plan = Schema.decodeUnknownSync(Plan)(
      await cli(repository, [
        "run",
        "reclaim",
        "plan",
        "--run",
        completed.runId,
      ])
    );
    expect(plan.families[0]?.runs).toBe(4);
    const receipt = await cli(repository, [
      "run",
      "reclaim",
      "apply",
      plan.planId,
    ]);
    expect(receipt).toMatchObject({ retiredFamilies: 1, retiredRuns: 4 });
    expect(
      await cli(repository, ["run", "reclaim", "apply", plan.planId])
    ).toEqual(receipt);
    const inspect = await cli(repository, [
      "run",
      "reclaim",
      "inspect",
      completed.runId,
    ]);
    expect(inspect).toMatchObject({ status: "Succeeded" });
    const after = new Database(
      path.join(repository, ".effectory/state.sqlite")
    );
    for (const identity of identities) {
      expect(
        after
          .query(
            "SELECT COUNT(*) count FROM cluster_messages WHERE entity_id=?"
          )
          .get(identity.engineId)
      ).toEqual({ count: 0 });
    }
    expect(
      after
        .query("SELECT COUNT(*) count FROM host_checks WHERE runId=?")
        .get(completed.runId)
    ).toEqual({ count: 0 });
    expect(after.query("PRAGMA foreign_key_check").all()).toEqual([]);
    after.close();
    await cli(repository, ["run", "reclaim", "compact"]);
    const snapshot = path.join(directory, "snapshot");
    await cli(repository, ["backup", snapshot]);
    const restored = path.join(directory, "restored");
    await cli(restored, ["restore", snapshot]);
    const next = await start(restored);
    children.push(next);
    const replay = await raw(restored, [
      "workflow",
      "run",
      "root",
      "--input",
      "null",
      "--request-key",
      "completed",
    ]);
    expect(replay.code).toBe(5);
    expect(replay.stderr).toContain("was retired");
    const gone = await raw(restored, ["run", "junit", completed.runId]);
    expect(gone.code).toBe(5);
    expect(gone.stderr).toContain("retired");
    if (!artifact) {
      throw new Error("Missing artifact");
    }
    const download = path.join(directory, "download.bin");
    await cli(restored, [
      "lake",
      "download",
      artifact.artifactId,
      "--version",
      String(artifact.version),
      "--output",
      download,
    ]);
    expect([...(await readFile(download))]).toEqual([1, 2, 3]);
    await cli(restored, ["run", "approve", wait.waitId]);
    for (let n = 0; n < 80; n += 1) {
      const run = Schema.decodeUnknownSync(Run)(
        await cli(restored, ["run", "get", waiting.runId])
      );
      if (run.status === "Succeeded") {
        break;
      }
      await Bun.sleep(50);
    }
    expect(
      Schema.decodeUnknownSync(Run)(
        await cli(restored, ["run", "get", waiting.runId])
      ).status
    ).toBe("Succeeded");
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 120_000);

test("SIGKILL at each retirement boundary resumes exact native cleanup and backup refuses without mutation", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-history-kill-")
  );
  const repository = path.join(directory, "repo");
  await mkdir(repository);
  let daemon: Awaited<ReturnType<typeof start>> | undefined;
  const stages = [
    "marker",
    "intent",
    "delete/host_events",
    "host-deleted",
    "before-native-clear",
    "after-native-clear",
    "before-receipt",
    "after-receipt",
  ];
  try {
    await writeFile(path.join(repository, "effectory.ts"), application);
    daemon = await start(repository);
    const runs: string[] = [];
    for (const stage of stages) {
      const run = Schema.decodeUnknownSync(Run)(
        await cli(repository, [
          "workflow",
          "run",
          "root",
          "--input",
          "null",
          "--request-key",
          stage,
        ])
      );
      await reportsDone(repository, run.runId);
      runs.push(run.runId);
    }
    await cli(repository, ["daemon", "stop"]);
    await daemon.exited;
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index];
      const runId = runs[index];
      if (!stage || !runId) {
        throw new Error("Missing crash case");
      }
      const plan = Schema.decodeUnknownSync(Plan)(
        await cli(repository, ["run", "reclaim", "plan", "--run", runId])
      );
      const worker = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "fixtures/run-reclamation-worker.ts"),
          repository,
          plan.planId,
          stage,
        ],
        { stderr: "pipe", stdout: "pipe" }
      );
      expect(await worker.exited).not.toBe(0);
      expect(await new Response(worker.stderr).text()).toBe("");
      const filename = path.join(repository, ".effectory/state.sqlite");
      const marker = path.join(repository, ".effectory/run-retirement.pending");
      expect(existsSync(marker)).toBe(true);
      const names = [filename, `${filename}-wal`, `${filename}-shm`, marker];
      const before = await Promise.all(
        names.map(async (name) =>
          existsSync(name) ? Bun.hash(await readFile(name)) : null
        )
      );
      const backup = await raw(repository, [
        "backup",
        path.join(directory, `snapshot-${index}`),
      ]);
      expect(backup.code).toBe(5);
      expect(backup.stderr).toContain("Unfinished run reclamation");
      expect(
        await Promise.all(
          names.map(async (name) =>
            existsSync(name) ? Bun.hash(await readFile(name)) : null
          )
        )
      ).toEqual(before);
      if (stage === "marker") {
        await cli(repository, ["run", "reclaim", "apply", plan.planId]);
      } else {
        daemon = await start(repository);
        await cli(repository, ["daemon", "stop"]);
        await daemon.exited;
      }
      const receipt = await cli(repository, [
        "run",
        "reclaim",
        "apply",
        plan.planId,
      ]);
      expect(receipt).toMatchObject({ retiredRuns: 4 });
      expect(existsSync(marker)).toBe(false);
      const db = new Database(filename);
      expect(
        db
          .query(
            "SELECT COUNT(*) count FROM host_retirement_native WHERE planId=?"
          )
          .get(plan.planId)
      ).toEqual({ count: 0 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();
    }
  } finally {
    if (daemon?.exitCode === null) {
      daemon.kill("SIGKILL");
    }
    if (daemon) {
      await daemon.exited;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 180_000);

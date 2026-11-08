/* oxlint-disable no-await-in-loop -- Stop and await each owned daemon before removing its repository. */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Run } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { digestOf } from "../src/application-bundle.ts";
import { RevisionReclaimPlan } from "../src/revision-reclaim-record.ts";
import { cli, effectory, start } from "./fixtures/cli.ts";

const application = (value: string) => `
import { Application, Task } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";
const task=Task.make({id:"value",version:1,input:Schema.Null,success:Schema.String,error:Schema.Never,replay:"idempotent"},()=>Effect.succeed(${JSON.stringify(value)}));
export default Application.make({tasks:[task]});
`;
async function raw(repository: string, args: string[]) {
  const child = Bun.spawn(
    [...effectory, ...args, "--repository", repository, "--json"],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr, stdout };
}

test("128-slot recovery, retired submission identity and historical reclamation diagnostics work through the real daemon", async () => {
  const repository = mkdtempSync(
    path.join(tmpdir(), "effectory-reclaim-lifecycle-")
  );
  const children: Awaited<ReturnType<typeof start>>[] = [];
  const state = path.join(repository, ".effectory");
  try {
    writeFileSync(path.join(repository, "effectory.ts"), application("first"));
    const first = await start(repository);
    children.push(first);
    const run = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "task",
        "run",
        "value",
        "--input",
        "null",
        "--request-key",
        "permanent",
      ])
    );
    expect(run.result).toBe("first");
    await cli(repository, ["daemon", "stop"]);
    await first.exited;
    const manifest = JSON.parse(
      readFileSync(
        path.join(state, "revisions", run.revision, "manifest.json"),
        "utf-8"
      )
    );
    for (let index = 0; index < 127; index += 1) {
      const source = `throw new Error("unused candidate ${index} must never import");`;
      const digest = digestOf(source);
      const revision = digestOf(`${manifest.hostAbi}/${digest}`);
      const directory = path.join(state, "revisions", revision);
      mkdirSync(directory);
      writeFileSync(path.join(directory, "application.mjs"), source);
      writeFileSync(
        path.join(directory, "manifest.json"),
        JSON.stringify({ ...manifest, digest })
      );
    }
    writeFileSync(path.join(repository, "effectory.ts"), application("second"));
    const exhausted = await raw(repository, ["daemon", "serve"]);
    expect(exhausted.code).not.toBe(0);
    expect(exhausted.stderr).toContain("128");
    const plan = Schema.decodeUnknownSync(RevisionReclaimPlan)(
      await cli(repository, ["revision", "reclaim", "plan", "--unreferenced"])
    );
    expect(plan.retainedCount).toBe(128);
    expect(plan.candidates).toHaveLength(127);
    expect(plan.projectedRetainedCount).toBe(1);
    expect(plan.protected.map((item) => item.revision)).toEqual([run.revision]);
    const reclaimed = await cli(repository, [
      "revision",
      "reclaim",
      "apply",
      plan.planId,
    ]);
    expect(reclaimed).toMatchObject({ removedFiles: 254 });
    const second = await start(repository);
    children.push(second);
    const current = Schema.decodeUnknownSync(Run)(
      await cli(repository, ["task", "run", "value", "--input", "null"])
    );
    expect(current.result).toBe("second");
    expect(current.revision).not.toBe(run.revision);
    await cli(repository, ["daemon", "stop"]);
    await second.exited;
    const beforeRetirement = Schema.decodeUnknownSync(RevisionReclaimPlan)(
      await cli(repository, [
        "revision",
        "reclaim",
        "plan",
        "--revision",
        run.revision,
      ])
    );
    expect(beforeRetirement.status).toBe("NoCandidates");
    const retirement = Schema.decodeUnknownSync(
      Schema.Struct({ planId: Schema.String })
    )(await cli(repository, ["run", "reclaim", "plan", "--run", run.runId]));
    await cli(repository, ["run", "reclaim", "apply", retirement.planId]);
    const deletion = Schema.decodeUnknownSync(RevisionReclaimPlan)(
      await cli(repository, [
        "revision",
        "reclaim",
        "plan",
        "--revision",
        run.revision,
      ])
    );
    expect(deletion.status).toBe("Ready");
    const receipt = await cli(repository, [
      "revision",
      "reclaim",
      "apply",
      deletion.planId,
    ]);
    const third = await start(repository);
    children.push(third);
    const retry = await raw(repository, [
      "task",
      "run",
      "value",
      "--input",
      "null",
      "--request-key",
      "permanent",
    ]);
    expect(retry.code).toBe(5);
    expect(retry.stderr).toContain(run.runId);
    expect(retry.stderr).toContain("reclaim inspect");
    const missing = await raw(repository, [
      "task",
      "describe",
      "value",
      "--revision",
      run.revision,
    ]);
    expect(missing.code).toBe(5);
    expect(missing.stderr).toContain(
      `revision reclaim inspect ${deletion.planId}`
    );
    await cli(repository, ["daemon", "stop"]);
    await third.exited;
    writeFileSync(path.join(repository, "effectory.ts"), application("first"));
    const fourth = await start(repository);
    children.push(fourth);
    const recreated = await raw(repository, [
      "task",
      "describe",
      "value",
      "--revision",
      run.revision,
    ]);
    expect(recreated.code, recreated.stderr).toBe(0);
    await cli(repository, ["daemon", "stop"]);
    await fourth.exited;
    expect(
      await cli(repository, ["revision", "reclaim", "apply", deletion.planId])
    ).toEqual(receipt);
    expect(
      existsSync(path.join(state, "revisions", run.revision, "application.mjs"))
    ).toBe(true);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
    rmSync(repository, { force: true, recursive: true });
  }
}, 180_000);

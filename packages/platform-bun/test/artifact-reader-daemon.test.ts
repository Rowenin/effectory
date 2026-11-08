import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ReclamationPlan, VersionPage } from "@effectory/runtime/lake-protocol";
import { Run } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { approval, cli, start } from "./fixtures/cli.ts";

const application = `
import { Application, Artifact, ArtifactReader, ArtifactStorage, ArtifactReadError, ArtifactUnavailable, Task, Workflow } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";
const Data=Artifact.make({id:"durable-data",version:1,schema:Schema.Int});
const errors=Schema.Union([ArtifactReadError,ArtifactUnavailable]);
const produce=Task.make({id:"produce",version:1,input:Schema.Null,success:Data.refSchema,error:Schema.Never,replay:"idempotent",outputs:{data:Data}},()=>Effect.gen(function*(){return yield* (yield* ArtifactStorage).publish(Data,42,{key:"main"});}));
const acquire=Task.make({id:"acquire",version:1,input:Data.refSchema,success:Data.refSchema,error:errors,replay:"idempotent"},ref=>Effect.gen(function*(){yield* (yield* ArtifactReader).metadata(Data,ref);return ref;}));
const read=Task.make({id:"read",version:1,input:Data.refSchema,success:Schema.Int,error:errors,replay:"idempotent"},ref=>Effect.gen(function*(){return yield* (yield* ArtifactReader).get(Data,ref);}));
const workflow=Workflow.make({id:"consume",version:1,input:Data.refSchema,success:Schema.Int,error:errors},Effect.gen(function*(){
 const graph=yield* Workflow.Builder;
 const pinned=yield* graph.task("acquire",acquire,yield* graph.input(Data.refSchema));
 const approval=yield* graph.approval("approve",{after:[pinned],prompt:"Read retained data?",timeout:"1 hour"});
 return yield* graph.task("read",read,pinned,{after:[approval]});
}));
export default Application.make({tasks:[produce,acquire,read],workflows:[workflow]});
`;

test("consumer pins survive SIGKILL and approval; reclamation releases them at terminal outcome", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-reader-durable-")
  );
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    await writeFile(path.join(repository, "effectory.ts"), application);
    const first = await start(repository);
    children.push(first);
    const produced = Schema.decodeUnknownSync(Run)(
      await cli(repository, ["task", "run", "produce", "--input", "null"])
    );
    expect(produced.status).toBe("Succeeded");
    const ref = Schema.decodeUnknownSync(
      Schema.Struct({ artifactId: Schema.String, version: Schema.Int })
    )(produced.result);
    const run = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "workflow",
        "run",
        "consume",
        "--input",
        JSON.stringify(produced.result),
        "--background",
      ])
    );
    const wait = await approval(repository, run.runId);
    const planArgs = [
      "lake",
      "reclaim",
      "plan",
      "--artifact",
      ref.artifactId,
      "--version",
      String(ref.version),
    ];
    const before = Schema.decodeUnknownSync(ReclamationPlan)(
      await cli(repository, planArgs)
    );
    expect(before.protectedBy?.consumerVersions).toBe(1);
    first.kill("SIGKILL");
    await first.exited;
    children.push(await start(repository));
    const page = Schema.decodeUnknownSync(VersionPage)(
      await cli(repository, ["lake", "versions", ref.artifactId])
    );
    expect(page.items[0]?.protection?.consumerRunIds).toEqual([run.runId]);
    const after = Schema.decodeUnknownSync(ReclamationPlan)(
      await cli(repository, planArgs)
    );
    expect(after.protectedVersions).toBe(1);
    await cli(repository, ["run", "approve", wait.waitId]);
    const finished = Schema.decodeUnknownSync(Run)(
      await cli(repository, ["run", "watch", run.runId])
    );
    expect(finished.status).toBe("Succeeded");
    expect(finished.result).toBe(42);
    const collectible = Schema.decodeUnknownSync(ReclamationPlan)(
      await cli(repository, planArgs)
    );
    expect(collectible.protectedVersions).toBe(0);
    expect(collectible.candidates).toHaveLength(1);
    await cli(repository, ["lake", "reclaim", "apply", collectible.planId]);
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
      })
    );
    await rm(repository, { force: true, recursive: true });
  }
}, 45_000);

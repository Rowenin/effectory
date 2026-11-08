/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Bounded process readiness and maintenance observations are sequential. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AutomaticReclamationStatus } from "@effectory/runtime/lake-protocol";
import { Schema } from "effect";

import { cli, start } from "./fixtures/cli.ts";

const application = `
import {Application,Artifact,ArtifactStorage,Task} from "@offtree/effectory-sdk";
import {Effect,Schema} from "effect";
const Value=Artifact.make({id:"value",version:1,schema:Schema.Int,retention:{maxVersions:1}});
const Producer=Task.make({id:"producer",version:1,input:Schema.Int,success:Schema.Int,error:Schema.Never,replay:"idempotent",outputs:{value:Value}},input=>Effect.gen(function*(){const storage=yield* ArtifactStorage;yield* storage.publish(Value,input,{key:"latest"});return input;}));
export default Application.make({tasks:[Producer]});
`;
const command = ["lake", "reclaim", "automatic"];

test("automatic CLI is opt-in, survives SIGKILL and offline restore, and exposes recoverable cleanup errors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-auto-cli-"));
  const repository = path.join(directory, "repository");
  const restored = path.join(directory, "restored");
  const children: Awaited<ReturnType<typeof start>>[] = [];
  const { mkdir } = await import("node:fs/promises");
  await mkdir(repository);
  const status = async (repo = repository) =>
    Schema.decodeUnknownSync(AutomaticReclamationStatus)(
      await cli(repo, [...command, "status"])
    );
  const sql = (query: string) => {
    const db = new Database(path.join(repository, ".effectory/state.sqlite"));
    try {
      db.run(query);
    } finally {
      db.close();
    }
  };
  try {
    await writeFile(path.join(repository, "effectory.ts"), application);
    const first = await start(repository);
    children.push(first);
    expect((await status()).enabled).toBe(false);
    await cli(repository, ["task", "run", "producer", "--input", "1"]);
    await cli(repository, ["task", "run", "producer", "--input", "2"]);
    expect((await status()).lastBatch).toBeNull();
    sql(
      "CREATE TRIGGER hold_cleanup BEFORE UPDATE OF started ON lake_reclamation_unlinks BEGIN SELECT RAISE(ABORT,'proof hold'); END"
    );
    await cli(repository, [...command, "enable"]);
    let held = false;
    for (let count = 0; count < 60; count += 1) {
      const current = await status();
      if (current.lastError !== null && current.lastBatch !== null) {
        held = true;
        break;
      }
      await Bun.sleep(50);
    }
    expect(held).toBe(true);
    const before = await status();
    expect(before.lastBatch?.receipt).toMatchObject({
      deletedVersions: 1,
      origin: "Automatic",
      pendingBytes: 1,
    });
    const doctor = JSON.stringify(await cli(repository, ["doctor"]));
    expect(doctor).toContain("AutomaticRetention");
    first.kill("SIGKILL");
    await first.exited;
    sql("DROP TRIGGER hold_cleanup");
    const second = await start(repository);
    children.push(second);
    const after = await status();
    expect(after.enabled).toBe(true);
    expect(after.lastBatch?.receipt.planId).toBe(
      before.lastBatch?.receipt.planId
    );
    expect(after.lastBatch?.receipt).toMatchObject({
      deletedVersions: 1,
      pendingBytes: 0,
      reclaimedBytes: 1,
    });
    await cli(repository, ["daemon", "stop", "--grace-period-ms", "0"]);
    await second.exited;
    const snapshot = path.join(directory, "snapshot");
    await cli(repository, ["backup", snapshot]);
    await cli(restored, ["restore", snapshot]);
    const third = await start(restored);
    children.push(third);
    expect((await status(restored)).enabled).toBe(true);
    await cli(restored, [...command, "disable"]);
    expect((await status(restored)).enabled).toBe(false);
    await cli(restored, ["daemon", "stop", "--grace-period-ms", "0"]);
    await third.exited;
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 90_000);

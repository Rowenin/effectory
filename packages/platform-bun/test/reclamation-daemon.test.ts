/* oxlint-disable no-await-in-loop -- Stateful CLI operations and process cleanup are ordered. */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ReclamationPlan,
  ReclamationReceipt,
  VersionPage,
} from "@effectory/runtime/lake-protocol";
import { Run } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { cli, start } from "./fixtures/cli.ts";

test("CLI plans, applies, lists tombstones and resumes the same receipt after backup and restore", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-reclaim-cli-")
  );
  let repository = path.join(directory, "original");
  await mkdir(repository);
  const children: Awaited<ReturnType<typeof start>>[] = [];
  try {
    await writeFile(
      path.join(repository, "effectory.ts"),
      `
import { Application, Artifact, ArtifactStorage, Task } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";
const Report = Artifact.make({ id: "report", version: 1, schema: Schema.Int, retention: { maxVersions: 1 } });
const Write = Task.make({ id: "write", version: 1, input: Schema.Int, success: Report.refSchema, error: Schema.Never, replay: "idempotent", outputs: { report: Report } }, (n) => Effect.gen(function* () { const storage = yield* ArtifactStorage; return yield* storage.publish(Report, n, { key: "main" }); }));
export default Application.make({ tasks: [Write] });
`
    );
    const first = await start(repository);
    children.push(first);
    let artifactId = "";
    for (const n of [1, 2]) {
      const run = Schema.decodeUnknownSync(Run)(
        await cli(repository, ["task", "run", "write", "--input", String(n)])
      );
      expect(run.status).toBe("Succeeded");
      ({ artifactId } = Schema.decodeUnknownSync(
        Schema.Struct({ artifactId: Schema.String })
      )(run.result));
    }
    const plan = Schema.decodeUnknownSync(ReclamationPlan)(
      await cli(repository, [
        "lake",
        "reclaim",
        "plan",
        "--policy",
        "--schema",
        "report",
      ])
    );
    expect(plan.candidates.map((item) => item.version)).toEqual([1]);
    const receipt = Schema.decodeUnknownSync(ReclamationReceipt)(
      await cli(repository, ["lake", "reclaim", "apply", plan.planId])
    );
    expect(receipt.deletedVersions).toBe(1);
    const page = Schema.decodeUnknownSync(VersionPage)(
      await cli(repository, [
        "lake",
        "versions",
        artifactId,
        "--include-reclaimed",
      ])
    );
    expect(page.items[0]?.reclamationPlanId).toBe(plan.planId);
    expect(page.items[1]?.reclaimedAt).toBeUndefined();
    first.kill("SIGKILL");
    await first.exited;
    const snapshot = path.join(directory, "snapshot");
    await cli(repository, ["backup", snapshot]);
    repository = path.join(directory, "restored");
    await cli(repository, ["restore", snapshot]);
    children.push(await start(repository));
    expect(
      Schema.decodeUnknownSync(ReclamationReceipt)(
        await cli(repository, ["lake", "reclaim", "apply", plan.planId])
      )
    ).toEqual(receipt);
    const explicit = Schema.decodeUnknownSync(ReclamationPlan)(
      await cli(repository, [
        "lake",
        "reclaim",
        "plan",
        "--artifact",
        artifactId,
        "--version",
        "2",
      ])
    );
    expect(explicit.emptiedArtifacts).toBe(1);
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

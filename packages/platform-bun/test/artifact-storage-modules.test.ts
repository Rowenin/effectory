import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Artifact, ArtifactStorage, Task } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

import { installHostModules } from "../src/host-runtime.ts";

test("application and extension imports resolve the same ArtifactStorage and canonical artifact", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-storage-modules-")
  );
  try {
    installHostModules();
    const extension = path.join(directory, "extension.mjs");
    const application = path.join(directory, "application.mjs");
    await writeFile(
      extension,
      `
import { ArtifactStorage } from "@offtree/effectory-sdk/ArtifactStorage";
import { Effect } from "effect";
export { ArtifactStorage };
export const publish = (artifact) => Effect.gen(function* () {
  const storage = yield* ArtifactStorage;
  return yield* storage.publish(artifact, 42, { key: "extension" });
});
`
    );
    await writeFile(
      application,
      `
import { Artifact, Task } from "@offtree/effectory-sdk";
import { Schema } from "effect";
import { publish } from "./extension.mjs";
const Report = Artifact.make({ id: "report", version: 1, schema: Schema.Int });
export const task = Task.make({ id: "report", version: 1, input: Schema.Null, success: Report.refSchema, error: Schema.Never, replay: "idempotent", outputs: { report: Report } }, () => publish(Report));
`
    );
    const ext = (await import(pathToFileURL(extension).href)) as {
      ArtifactStorage: typeof ArtifactStorage;
    };
    expect(ext.ArtifactStorage).toBe(ArtifactStorage);
    const app = (await import(pathToFileURL(application).href)) as {
      task: Task.Definition;
    };
    const result = await Effect.runPromise(
      Task.test(app.task, { input: null })
    );
    expect(result.publications[0]?.value).toBe(42);
    const report = Artifact.make({
      id: "report",
      schema: Schema.Int,
      version: 1,
    });
    expect(Schema.is(report.refSchema)(result.value)).toBe(true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

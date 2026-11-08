import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Artifact, ArtifactStorage, Task } from "@offtree/effectory-sdk";
import { Effect } from "effect";

import { installHostModules } from "../src/host-runtime.ts";

test("binary definitions and storage retain identity across application and extension modules in both directions", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-binary-modules-")
  );
  try {
    installHostModules();
    const extension = path.join(directory, "extension.mjs");
    const application = path.join(directory, "application.mjs");
    await writeFile(
      extension,
      `
import * as Artifact from "@offtree/effectory-sdk/Artifact";
import { ArtifactStorage } from "@offtree/effectory-sdk/ArtifactStorage";
import { Effect, Stream } from "effect";
export { ArtifactStorage };
export const make = Artifact.make;
export const ExtensionBytes = Artifact.make({ id: "extension/bytes", version: 1, kind: "bytes", contentType: "application/octet-stream" });
export const publish = (artifact) => Effect.gen(function* () {
  const storage = yield* ArtifactStorage;
  return yield* storage.publish(artifact, Stream.make(new Uint8Array([0, 255, 42])), { key: "extension" });
});
`
    );
    await writeFile(
      application,
      `
import { Artifact, ArtifactStorage, Task, Extension, Application } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";
import { ExtensionBytes, publish } from "./extension.mjs";
export const ApplicationBytes = Artifact.make({ id: "application/bytes", version: 1, kind: "bytes", contentType: "application/octet-stream" });
export const extension = Extension.make({ id: "example/bytes", version: "1.0.0", artifacts: { Bytes: ExtensionBytes } });
export const task = Task.make({ id: "binary-modules", version: 1, input: Schema.Null, success: ExtensionBytes.refSchema, error: Schema.Never, replay: "idempotent", outputs: { fromApp: ApplicationBytes, fromExtension: ExtensionBytes } }, () => Effect.gen(function* () {
  yield* publish(ApplicationBytes);
  const storage = yield* ArtifactStorage;
  return yield* storage.publish(ExtensionBytes, new Uint8Array([42, 255, 0]), { key: "application" });
}));
export const application = Application.make({ tasks: [task], extensions: [Extension.use(extension)] });
`
    );
    const ext = (await import(pathToFileURL(extension).href)) as {
      ArtifactStorage: typeof ArtifactStorage;
      make: typeof Artifact.make;
    };
    expect(ext.ArtifactStorage).toBe(ArtifactStorage);
    expect(ext.make).toBe(Artifact.make);
    const app = (await import(pathToFileURL(application).href)) as {
      task: Task.Definition;
    };
    const result = await Effect.runPromise(
      Task.test(app.task, { input: null, tags: { team: "binary" } })
    );
    expect(result.publications).toHaveLength(2);
    for (const publication of result.publications) {
      expect(publication.kind).toBe("bytes");
      expect(publication.tags).toEqual({ team: "binary" });
    }
    const [fromApp, fromExtension] = result.publications;
    expect(fromApp?.kind === "bytes" && [...fromApp.bytes]).toEqual([
      0, 255, 42,
    ]);
    expect(fromExtension?.kind === "bytes" && [...fromExtension.bytes]).toEqual(
      [42, 255, 0]
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

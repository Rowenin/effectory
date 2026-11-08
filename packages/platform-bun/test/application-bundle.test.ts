import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Effect } from "effect";

import {
  assertUnchanged,
  buildApplication,
  digestOf,
} from "../src/application-bundle.ts";

test("dependency package metadata is bundled and covered by the source snapshot", async () => {
  const repository = await realpath(
    await mkdtemp(path.join(tmpdir(), "effectory-package-json-"))
  );
  try {
    const dependency = path.join(repository, "node_modules", "metadata-reader");
    await mkdir(dependency, { recursive: true });
    const manifest = JSON.stringify({
      exports: "./index.js",
      name: "metadata-reader",
      type: "module",
      version: "1.2.3",
    });
    const filename = path.join(dependency, "package.json");
    await writeFile(filename, manifest);
    await writeFile(
      path.join(dependency, "index.js"),
      'import metadata from "./package.json"; export default metadata.version;'
    );
    await writeFile(
      path.join(repository, "effectory.ts"),
      'import version from "metadata-reader"; export default version;'
    );
    const bundle = await Effect.runPromise(buildApplication(repository));
    expect(bundle.inputs.get(filename)).toBe(digestOf(manifest));
    expect(() => assertUnchanged(bundle.inputs)).not.toThrow();
    const retained = path.join(repository, "retained.mjs");
    await writeFile(retained, bundle.source);
    const imported = await import(pathToFileURL(retained).href);
    expect(imported.default).toBe("1.2.3");

    await writeFile(filename, manifest.replace("1.2.3", "2.0.0"));
    expect(() => assertUnchanged(bundle.inputs)).toThrow(
      "Application source or active revision changed"
    );
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test.each([
  ["unsupported.jsonc", '{"value":true}'],
  ["unsupported.txt", "text"],
  ["oversized.json", JSON.stringify("x".repeat(16_777_216))],
])("JSON metadata support still rejects %s", async (name, contents) => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-module-limits-")
  );
  try {
    await writeFile(path.join(repository, name), contents);
    await writeFile(
      path.join(repository, "effectory.ts"),
      `import data from "./${name}"; export default data;`
    );
    const result = await Effect.runPromise(
      Effect.result(buildApplication(repository))
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("RevisionUnavailable");
    }
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

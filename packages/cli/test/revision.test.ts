import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { normalizeArgs } from "../src/cli.ts";
import { lockfile, revision, sourceFiles } from "../src/revision.ts";

const repo = path.resolve(import.meta.dir, "../../..");
let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) {
    rmSync(scratch, { force: true, recursive: true });
    scratch = undefined;
  }
});

/** A collection inside the repo, so `@effectory/core` and `effect` resolve. */
const collection = (files: Readonly<Record<string, string>>) => {
  scratch = realpathSync(mkdtempSync(path.join(import.meta.dir, ".tmp-rev-")));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(scratch, name), content);
  }
  return path.join(scratch, "effectory.ts");
};

describe("revision", () => {
  test("follows local and workspace imports, not node_modules", () => {
    const root = collection({
      "effectory.ts": [
        'import { Collection } from "@effectory/core";',
        'import { Effect } from "effect";',
        'import { readFileSync } from "node:fs";',
        'import { helper } from "./helper.ts";',
        "export default [Collection, Effect, readFileSync, helper];",
      ].join("\n"),
      "helper.ts": 'export { nested as helper } from "./nested.ts";',
      "nested.ts": "export const nested = 1;",
      "unused.ts": "export const unused = 1;",
    });
    const files = sourceFiles(root).map((file) =>
      path.relative(repo, file).split(path.sep).join("/")
    );
    const local = files.filter((file) => file.includes(".tmp-rev-"));
    expect(local.map((file) => path.basename(file)).toSorted()).toEqual([
      "effectory.ts",
      "helper.ts",
      "nested.ts",
    ]);
    expect(files).toContain("packages/core/src/index.ts");
    expect(files).toContain("packages/core/src/engine.ts");
    expect(files.some((file) => file.includes("node_modules"))).toBe(false);
    expect(files.some((file) => file.endsWith("unused.ts"))).toBe(false);
    expect(lockfile(path.dirname(root))).toBe(path.join(repo, "bun.lock"));
  });

  test("is deterministic and changes only with imported source", () => {
    const root = collection({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
      "effectory.ts": 'import "./b.ts";\nimport "./a.ts";\n',
      "unused.ts": "export const unused = 1;",
    });
    const first = revision(root);
    expect(first).toMatch(/^[\da-f]{64}$/u);
    expect(revision(root)).toBe(first);
    writeFileSync(path.join(path.dirname(root), "unused.ts"), "export {};");
    expect(revision(root)).toBe(first);
    writeFileSync(path.join(path.dirname(root), "a.ts"), "export const a = 3;");
    const changed = revision(root);
    expect(changed).not.toBe(first);
    writeFileSync(path.join(path.dirname(root), "a.ts"), "export const a = 1;");
    expect(revision(root)).toBe(first);
  });
});

describe("normalizeArgs", () => {
  test("joins --junit with a following .xml file", () => {
    expect(normalizeArgs(["run", "w", "--junit", "out.xml"])).toEqual([
      "run",
      "w",
      "--junit=out.xml",
    ]);
    expect(normalizeArgs(["run", "--junit", "w"])).toEqual([
      "run",
      "--junit",
      "w",
    ]);
  });
});

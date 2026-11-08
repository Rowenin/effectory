import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";

import { Catalog } from "../src/catalog.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { revisionCatalogLayer } from "../src/revisions.ts";

const source = (label: string, marker: string) => `
import { appendFileSync } from "node:fs";
import { Application } from "@offtree/effectory-sdk";
import { Context, Effect, Layer } from "effect";
const Resource = Context.Service("test/RevisionLifetime");
const record = (phase) => Effect.sync(() => appendFileSync(${JSON.stringify(marker)}, phase + ":" + ${JSON.stringify(label)} + "\\n"));
const resource = Layer.effect(Resource, Effect.acquireRelease(record("acquire"), () => record("release")));
export default Application.make({}).provide(resource);
`;

test("revision Layers release after scoped borrowers and restart loads only the active revision", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "effectory-lifetime-"));
  const state = path.join(repository, ".effectory");
  const marker = path.join(repository, "resources.txt");
  const filename = path.join(repository, "effectory.ts");
  const records = async () => {
    const text = await readFile(marker, "utf-8");
    return text.trim().split("\n");
  };
  const layer = () =>
    revisionCatalogLayer(repository).pipe(
      Layer.provide(ownershipLayer(path.join(state, "owner")))
    );
  try {
    await mkdir(state);
    await writeFile(filename, source("first", marker));
    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        yield* Effect.promise(() =>
          writeFile(filename, source("second", marker))
        );
        const stale = yield* catalog.prepare();
        yield* Effect.promise(() =>
          writeFile(filename, source("third", marker))
        );
        expect((yield* Effect.result(catalog.activate(stale)))._tag).toBe(
          "Failure"
        );
        yield* catalog.activate(yield* catalog.prepare());
        expect(yield* Effect.promise(records)).toEqual([
          "acquire:first",
          "acquire:second",
          "acquire:third",
          "release:first",
        ]);
      }).pipe(Effect.scoped, Effect.provide(layer()))
    );
    const first = await records();
    expect(
      first.filter((line) => line.startsWith("release:")).toSorted()
    ).toEqual(["release:first", "release:second", "release:third"]);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Catalog;
        const restarted = yield* Effect.promise(records);
        expect(restarted.slice(first.length)).toEqual(["acquire:third"]);
      }).pipe(Effect.scoped, Effect.provide(layer()))
    );
    const all = await records();
    expect(all.filter((line) => line.startsWith("release:"))).toHaveLength(4);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("manifest publication failure closes the newly loaded application before prepare returns", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-manifest-failure-")
  );
  const state = path.join(repository, ".effectory");
  const marker = path.join(repository, "resources.txt");
  const filename = path.join(repository, "effectory.ts");
  try {
    await mkdir(state);
    await writeFile(filename, source("first", marker));
    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        const { active } = catalog;
        // A directory at the target makes the manifest's atomic rename fail,
        // after the application Layer has successfully acquired its resource.
        const broken = source("broken", marker)
          .replace(
            "import { appendFileSync }",
            "import { appendFileSync, mkdirSync }"
          )
          .replace(
            'record("acquire")',
            'record("acquire").pipe(Effect.tap(() => Effect.sync(() => mkdirSync(new URL("./manifest.json", import.meta.url)))))'
          );
        yield* Effect.promise(() => writeFile(filename, broken));
        expect((yield* Effect.result(catalog.prepare()))._tag).toBe("Failure");
        expect(catalog.active).toBe(active);
        const text = yield* Effect.promise(() => readFile(marker, "utf-8"));
        expect(text.trim().split("\n")).toEqual([
          "acquire:first",
          "acquire:broken",
          "release:broken",
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          revisionCatalogLayer(repository).pipe(
            Layer.provide(ownershipLayer(path.join(state, "owner")))
          )
        )
      )
    );
    const text = await readFile(marker, "utf-8");
    expect(text.trim().split("\n")).toEqual([
      "acquire:first",
      "acquire:broken",
      "release:broken",
      "release:first",
    ]);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

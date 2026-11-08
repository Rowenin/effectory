import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Exit, Fiber, Layer } from "effect";

import { Catalog } from "../src/catalog.ts";
import { ownershipLayer, RepositoryLease } from "../src/ownership.ts";
import { revisionCatalogLayer } from "../src/revisions.ts";

type Boundary = "preparing" | "published";
const application = (label: string, marker: string, boundary: Boundary) => `
import { appendFileSync, existsSync } from "node:fs";
import { Application } from "@offtree/effectory-sdk";
import { Context, Effect, Layer } from "effect";
const Resource = Context.Service("test/ActivationShutdown");
const record = (phase) => Effect.sync(() => appendFileSync(${JSON.stringify(marker)}, phase + ":" + ${JSON.stringify(label)} + "\\n"));
const wait = (suffix) => Effect.gen(function* () {
  while (!existsSync(${JSON.stringify(marker)} + suffix)) yield* Effect.sleep("5 millis");
});
const gated = ${JSON.stringify(boundary === "preparing" ? label === "second" : label === "first")};
const resource = Layer.effect(Resource,
  Effect.acquireRelease(record("acquire"), () => Effect.gen(function* () {
    yield* record("release-start");
    if (gated) yield* wait(".release");
    yield* record("release-end");
  })).pipe(Effect.tap(() => ${JSON.stringify(boundary === "preparing" && label === "second")}
    ? record("preparing").pipe(Effect.andThen(wait(".prepare")))
    : Effect.void))
);
export default Application.make({}).provide(resource);
`;

test.each(["preparing", "published"] as const)(
  "shutdown during %s activation drains application cleanup before releasing repository ownership",
  async (boundary) => {
    const repository = await mkdtemp(
      path.join(tmpdir(), "effectory-activation-shutdown-")
    );
    const state = path.join(repository, ".effectory");
    const filename = path.join(repository, "effectory.ts");
    const marker = path.join(repository, "resources.txt");
    const owner = path.join(state, "owner");
    const records = Effect.promise(() => readFile(marker, "utf-8")).pipe(
      Effect.map((text) => text.trim().split("\n"))
    );
    const until = (entry: string) =>
      Effect.gen(function* () {
        while (!(yield* records).includes(entry)) {
          yield* Effect.sleep("5 millis");
        }
      }).pipe(Effect.timeout("10 seconds"));
    const active = Effect.promise(async () => {
      const text = await readFile(path.join(state, "active.json"), "utf-8");
      return (JSON.parse(text) as { revision: string }).revision;
    });
    const release = Effect.promise(() =>
      writeFile(`${marker}.release`, "continue")
    );
    const layer = () =>
      revisionCatalogLayer(repository).pipe(
        Layer.provide(ownershipLayer(owner))
      );
    let original = "";
    try {
      await mkdir(state);
      await writeFile(marker, "");
      await writeFile(filename, application("first", marker, boundary));
      await Effect.runPromise(
        Effect.gen(function* () {
          const host = yield* Effect.gen(function* () {
            const catalog = yield* Catalog;
            original = catalog.active;
            yield* Effect.promise(() =>
              writeFile(filename, application("second", marker, boundary))
            );
            // Match the administration worker: its scoped child closes before
            // the Layer that supplied its catalog and repository ownership.
            yield* Effect.gen(function* () {
              yield* catalog.activate(yield* catalog.prepare());
            }).pipe(Effect.scoped, Effect.forkScoped);
            return yield* Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.promise(() => appendFile(marker, "shutdown-start\n"))
              )
            );
          }).pipe(Effect.scoped, Effect.provide(layer()), Effect.forkScoped);
          yield* until(
            boundary === "preparing"
              ? "preparing:second"
              : "release-start:first"
          );
          const chosen = yield* active;
          if (boundary === "preparing") {
            expect(chosen).toBe(original);
          } else {
            expect(chosen).not.toBe(original);
          }
          const shutdown = yield* Fiber.interrupt(host).pipe(Effect.forkScoped);
          yield* until("shutdown-start");
          yield* until(
            boundary === "preparing"
              ? "release-start:second"
              : "release-start:first"
          );
          expect(shutdown.pollUnsafe()).toBeUndefined();
          expect(yield* records).not.toContain("release-end:first");
          expect(yield* records).not.toContain("release-end:second");
          // A new owner must not enter while the old application finalizer is
          // still using resources, even after active.json has been published.
          const competing = yield* Effect.exit(
            RepositoryLease.pipe(Effect.provide(ownershipLayer(owner)))
          );
          expect(Exit.isFailure(competing)).toBe(true);
          yield* release;
          yield* Fiber.join(shutdown);
          expect(Exit.hasInterrupts(yield* Fiber.await(host))).toBe(true);
          const recorded = yield* records;
          expect(
            recorded.filter((line) => line === "release-end:first")
          ).toHaveLength(1);
          expect(
            recorded.filter((line) => line === "release-end:second")
          ).toHaveLength(1);
          expect(recorded.indexOf("release-end:first")).toBe(
            boundary === "preparing" ? recorded.length - 1 : recorded.length - 3
          );
          expect(yield* active).toBe(chosen);
          yield* RepositoryLease.pipe(Effect.provide(ownershipLayer(owner)));
        }).pipe(Effect.ensuring(release), Effect.scoped)
      );
      // Current source is the second revision. A cancelled prepare has no
      // published manifest; restart discards it and loads that source afresh.
      await writeFile(`${marker}.prepare`, "continue");
      const directories = await readdir(path.join(state, "revisions"));
      expect(directories).toHaveLength(2);
      for (const revision of directories) {
        expect(
          existsSync(path.join(state, "revisions", revision, "manifest.json"))
        ).toBe(revision === original || boundary === "published");
      }
      const beforeText = await readFile(marker, "utf-8");
      const before = beforeText.trim().split("\n");
      await Effect.runPromise(
        Catalog.pipe(
          Effect.tap((catalog) =>
            Effect.sync(() => {
              expect(catalog.active).not.toBe(original);
            })
          ),
          Effect.provide(layer())
        )
      );
      const afterText = await readFile(marker, "utf-8");
      const after = afterText.trim().split("\n");
      expect(after.slice(before.length)).toEqual([
        "acquire:second",
        ...(boundary === "preparing" ? ["preparing:second"] : []),
        "release-start:second",
        "release-end:second",
      ]);
    } finally {
      await rm(repository, { force: true, recursive: true });
    }
  },
  20_000
);

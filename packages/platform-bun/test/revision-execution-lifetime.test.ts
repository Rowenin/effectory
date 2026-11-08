import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { Catalog } from "../src/catalog.ts";
import { HostStore } from "../src/host-store.ts";
import { hostLayer } from "../src/host.ts";
import { revisionCatalogLayer } from "../src/revisions.ts";
import { Runner } from "../src/runner.ts";

const application = (label: string, marker: string) => `
import { appendFileSync, existsSync } from "node:fs";
import { Application, Task } from "@offtree/effectory-sdk";
import { Context, Effect, Layer, Schema } from "effect";
const Resource = Context.Service("test/RevisionExecution");
const Cleanup = Context.Service("test/RevisionExecutionCleanup");
const record = (phase) => Effect.sync(() => appendFileSync(${JSON.stringify(marker)}, phase + ":" + ${JSON.stringify(label)} + "\\n"));
const wait = (suffix) => Effect.gen(function* () {
 while (!existsSync(${JSON.stringify(marker)} + suffix)) yield* Effect.sleep("5 millis");
});
const resource = Layer.effect(Resource, Effect.acquireRelease(
 record("acquire").pipe(Effect.as(${JSON.stringify(label)})), () => record("release")
));
const cleanup = Layer.effect(Cleanup, Effect.acquireRelease(Effect.void, () =>
 Effect.gen(function* () {
  yield* Resource;
  yield* record("cleanup");
  yield* wait(".cleanup");
  yield* record("cleaned");
 })
));
const work = Task.make({ id: "work", version: 1, input: Schema.Null, success: Schema.String, error: Schema.Never, replay: "idempotent" }, () => Effect.gen(function* () {
 const value = yield* Resource;
 yield* record("handler");
 yield* wait(".handler");
 return value;
})).provide(cleanup);
export default Application.make({ tasks: [work] }).provide(resource);
`;

test("activation keeps a running task's application alive until task cleanup and native execution finish", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-revision-execution-")
  );
  const filename = path.join(repository, "effectory.ts");
  const marker = path.join(repository, "lifetime.txt");
  const state = path.join(repository, ".effectory");
  const records = Effect.promise(
    async () => await readFile(marker, "utf-8")
  ).pipe(Effect.map((text) => text.trim().split("\n")));
  const until = (phase: string) =>
    Effect.gen(function* () {
      while (!(yield* records).includes(phase)) {
        yield* Effect.sleep("5 millis");
      }
    });
  try {
    await mkdir(state);
    await writeFile(filename, application("first", marker));
    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        const runner = yield* Runner;
        const store = yield* HostStore;
        const run = yield* runner.submit(
          {
            input: null,
            kind: "task",
            requestKey: "lifetime",
            targetId: "work",
          },
          "owner"
        );
        yield* until("handler:first");
        yield* Effect.promise(
          async () => await writeFile(filename, application("second", marker))
        );
        yield* Effect.gen(function* () {
          yield* catalog.activate(yield* catalog.prepare());
        }).pipe(Effect.scoped);
        expect(catalog.active).not.toBe(run.revision);
        expect(yield* records).toEqual([
          "acquire:first",
          "handler:first",
          "acquire:second",
        ]);
        yield* Effect.promise(
          async () => await writeFile(`${marker}.handler`, "continue")
        );
        yield* until("cleanup:first");
        expect(yield* records).not.toContain("release:first");
        expect((yield* store.getRun(run.runId)).status).toBe("Running");
        yield* Effect.promise(
          async () => await writeFile(`${marker}.cleanup`, "continue")
        );
        yield* until("release:first");
        let finished = yield* store.getRun(run.runId);
        while (finished.status !== "Succeeded") {
          yield* Effect.sleep("10 millis");
          finished = yield* store.getRun(run.runId);
        }
        expect(finished.result).toBe("first");
        expect(finished.revision).toBe(run.revision);
        expect(yield* records).toEqual([
          "acquire:first",
          "handler:first",
          "acquire:second",
          "cleanup:first",
          "cleaned:first",
          "release:first",
        ]);
      }).pipe(
        Effect.ensuring(
          Effect.promise(
            async () =>
              await Promise.all([
                writeFile(`${marker}.handler`, "continue"),
                writeFile(`${marker}.cleanup`, "continue"),
              ])
          )
        ),
        Effect.timeout("15 seconds"),
        Effect.scoped,
        Effect.provide(
          hostLayer({
            blobs: path.join(state, "blobs"),
            catalog: revisionCatalogLayer(repository),
            database: path.join(state, "state.sqlite"),
          })
        )
      )
    );
    const final = await readFile(marker, "utf-8");
    expect(final.trim().split("\n").at(-1)).toBe("release:second");
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
}, 25_000);

test("host shutdown retains an inactive revision through its native Activity's cleanup", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-revision-shutdown-")
  );
  const filename = path.join(repository, "effectory.ts");
  const marker = path.join(repository, "lifetime.txt");
  const state = path.join(repository, ".effectory");
  // The handler stays open until host shutdown interrupts it. Cleanup is finite
  // but deliberately asynchronous, exposing the separate Activity fiber.
  const source = (label: string) =>
    application(label, marker).replace(
      'yield* wait(".cleanup");',
      'yield* Effect.sleep("50 millis");'
    );
  const records = Effect.promise(
    async () => await readFile(marker, "utf-8")
  ).pipe(Effect.map((text) => text.trim().split("\n")));
  try {
    await mkdir(state);
    await writeFile(filename, source("first"));
    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        const runner = yield* Runner;
        yield* runner.submit(
          {
            input: null,
            kind: "task",
            requestKey: "shutdown",
            targetId: "work",
          },
          "owner"
        );
        while (!(yield* records).includes("handler:first")) {
          yield* Effect.sleep("5 millis");
        }
        yield* Effect.promise(
          async () => await writeFile(filename, source("second"))
        );
        yield* Effect.gen(function* () {
          yield* catalog.activate(yield* catalog.prepare());
        }).pipe(Effect.scoped);
        expect(yield* records).not.toContain("release:first");
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.scoped,
        Effect.provide(
          hostLayer({
            blobs: path.join(state, "blobs"),
            catalog: revisionCatalogLayer(repository),
            database: path.join(state, "state.sqlite"),
          })
        )
      )
    );
    const recorded = await Effect.runPromise(records);
    expect(recorded).toEqual([
      "acquire:first",
      "handler:first",
      "acquire:second",
      "cleanup:first",
      "cleaned:first",
      "release:first",
      "release:second",
    ]);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
}, 25_000);

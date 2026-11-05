import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Task } from "@effectory/core";
import { Effect, Layer } from "effect";

import { Catalog } from "../src/catalog.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { revisionCatalogLayer } from "../src/revisions.ts";

function application(value: string) {
  return `import { Application, Task } from "@effectory/core";
import { Effect, Schema } from "effect";
const task = Task.make({ id: "value", version: 1, input: Schema.Struct({}), success: Schema.String, error: Schema.Never, replay: "idempotent" }, () => Effect.succeed(${JSON.stringify(value)}));
export default Application.make({ tasks: [task] });`;
}
const context: Task.RuntimeContext = {
  attempt: 1,
  attemptId: "test",
  invocationPath: "task",
  key: (name) => name,
  progress: () => Effect.void,
  publish: () => Effect.die("No publication expected"),
  revision: "test",
  runId: "test",
  taskId: "value",
  taskVersion: 1,
};

test("source changes retain executable old application revisions with canonical host imports", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "effectory-revisions-"));
  const state = path.join(repository, ".effectory");
  await mkdir(state);
  const layer = () =>
    revisionCatalogLayer(repository).pipe(
      Layer.provide(ownershipLayer(path.join(state, "state.sqlite.owner")))
    );
  try {
    await writeFile(
      path.join(repository, "effectory.ts"),
      application("first")
    );
    const first = await Effect.runPromise(
      Effect.map(Catalog, (catalog) => catalog.active).pipe(
        Effect.provide(layer())
      )
    );
    await writeFile(
      path.join(repository, "effectory.ts"),
      application("second")
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        expect(catalog.active).not.toBe(first);
        const previous = yield* catalog.get(first);
        const current = yield* catalog.get();
        const oldTask = previous.registry.tasks.get("value");
        const newTask = current.registry.tasks.get("value");
        if (!oldTask || !newTask) {
          return yield* Effect.die("Missing retained task");
        }
        expect(yield* oldTask.execute({}, context)).toBe("first");
        expect(yield* newTask.execute({}, context)).toBe("second");
      }).pipe(Effect.provide(layer()))
    );
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("activation rejects stale source and stale candidates while retaining the previous registry", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-activation-")
  );
  const state = path.join(repository, ".effectory");
  await mkdir(state);
  const filename = path.join(repository, "effectory.ts");
  try {
    await writeFile(filename, application("first"));
    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        const first = catalog.active;
        yield* Effect.promise(() => writeFile(filename, application("second")));
        const stale = yield* catalog.prepare();
        expect(catalog.active).toBe(first);
        yield* Effect.promise(() => writeFile(filename, application("third")));
        const rejected = yield* Effect.result(catalog.activate(stale));
        expect(rejected._tag).toBe("Failure");
        expect(catalog.active).toBe(first);
        const third = yield* catalog.prepare();
        const competing = yield* catalog.prepare();
        yield* catalog.activate(third);
        expect(catalog.active).toBe(third.revision);
        expect((yield* Effect.result(catalog.activate(competing)))._tag).toBe(
          "Failure"
        );
        const prior = (yield* catalog.get(first)).registry.tasks.get("value");
        const current = (yield* catalog.get()).registry.tasks.get("value");
        if (!prior || !current) {
          return yield* Effect.die("Missing task");
        }
        expect(yield* prior.execute({}, context)).toBe("first");
        expect(yield* current.execute({}, context)).toBe("third");
        yield* Effect.promise(() =>
          writeFile(
            filename,
            application("invalid").replace(
              "tasks: [task]",
              "tasks: [task, task]"
            )
          )
        );
        expect((yield* Effect.result(catalog.prepare()))._tag).toBe("Failure");
        expect(catalog.active).toBe(third.revision);
        yield* Effect.promise(() => writeFile(filename, application("third")));
      }).pipe(
        Effect.provide(
          revisionCatalogLayer(repository).pipe(
            Layer.provide(ownershipLayer(path.join(state, "owner")))
          )
        )
      )
    );
    // A failed candidate is not loaded as a retained revision on restart.
    await Effect.runPromise(
      Effect.gen(function* () {
        const task = (yield* (yield* Catalog).get()).registry.tasks.get(
          "value"
        );
        if (!task) {
          return yield* Effect.die("Missing task");
        }
        expect(yield* task.execute({}, context)).toBe("third");
      }).pipe(
        Effect.provide(
          revisionCatalogLayer(repository).pipe(
            Layer.provide(ownershipLayer(path.join(state, "owner")))
          )
        )
      )
    );
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

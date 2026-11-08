import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Application, Task } from "@offtree/effectory-sdk";
import { Effect, Layer, Schema } from "effect";

import { catalogLayer } from "../src/catalog.ts";
import { listDefinitions } from "../src/definition-discovery.ts";
import { hostStoreLayer } from "../src/host-store.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { createPagination } from "../src/pagination.ts";

test("discovery pages retain revision and filters with more than 200 registered definitions", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "effectory-discovery-"));
  try {
    const tasks = Array.from({ length: 205 }, (_, index) =>
      Task.make(
        {
          error: Schema.Never,
          id: `example/task-${String(index).padStart(3, "0")}`,
          input: Schema.Null,
          replay: "idempotent",
          success: Schema.Null,
          version: 1,
        },
        () => Effect.succeed(null)
      )
    );
    const application = Application.make({ tasks });
    const catalog = Layer.unwrap(
      Effect.map(Application.Registry, (registry) =>
        catalogLayer("first", new Map([["first", registry]]))
      )
    ).pipe(Layer.provide(application.layer));
    const services = Layer.merge(
      catalog,
      hostStoreLayer(path.join(repository, "state.sqlite"))
    ).pipe(Layer.provide(ownershipLayer(path.join(repository, "owner"))));
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* listDefinitions(
          "task",
          { limit: 200, namespace: "example" },
          "owner"
        );
        expect(first.items).toHaveLength(200);
        if (first.cursor === null) {
          return yield* Effect.die("Expected discovery cursor");
        }
        const next = yield* listDefinitions(
          "task",
          { cursor: first.cursor, limit: 200, namespace: "example" },
          "owner"
        );
        expect(next.items).toHaveLength(5);
        expect(next.items[0]?.id).toBe("example/task-200");
        expect(next.revision).toBe("first");
        expect(next.cursor).toBeNull();
        expect(
          (yield* Effect.result(
            listDefinitions(
              "workflow",
              { cursor: first.cursor, limit: 200, namespace: "example" },
              "owner"
            )
          ))._tag
        ).toBe("Failure");
        expect(
          (yield* Effect.result(
            listDefinitions(
              "task",
              { cursor: first.cursor, limit: 200, namespace: "example" },
              "other"
            )
          ))._tag
        ).toBe("Failure");
        expect(
          (yield* listDefinitions(
            "task",
            { search: "TASK-204" },
            "owner"
          )).items.map((item) => item.id)
        ).toEqual(["example/task-204"]);
      }).pipe(Effect.provide(services))
    );
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("page cursors reject tampering and expiry without extending a snapshot's lifetime", () => {
  const pages = createPagination("test-secret");
  const scope = { kind: "test", principal: "owner", query: {} };
  const token = pages.write(scope, "revision", "position", Date.now() + 10_000);
  expect(pages.read(scope, token)?.position).toBe("position");
  expect(() => pages.read(scope, `${token}.extra`)).toThrow(
    "Invalid page cursor"
  );
  expect(() => pages.read(scope, `x${token}`)).toThrow("Invalid page cursor");
  expect(() =>
    pages.read(scope, pages.write(scope, "revision", "position", 0))
  ).toThrow("expired");
});

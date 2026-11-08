/* oxlint-disable max-classes-per-file -- Separate services model task setup and a nested source Layer. */
import { expect, test } from "bun:test";

import { Context, Deferred, Effect, Layer, Schema, Stream } from "effect";

import { Artifact, ArtifactStorage, Task } from "../src/index.ts";
import { publicationLifetime } from "../src/publication-lifetime.ts";

const Json = Artifact.make({
  id: "nested/json",
  schema: Schema.String,
  version: 1,
});
const Bytes = Artifact.make({
  contentType: "application/octet-stream",
  id: "nested/bytes",
  kind: "bytes",
  version: 1,
});
const spec = {
  error: Schema.Never,
  id: "nested/publisher",
  input: Schema.Null,
  outputs: { bytes: Bytes, json: Json },
  replay: "idempotent" as const,
  success: Schema.Boolean,
  version: 1,
};

// Distinct resources verify nested Layer release independently of task setup.
class Ready extends Context.Service<Ready, boolean>()("nested/Ready") {}
class Source extends Context.Service<Source, Uint8Array>()("nested/Source") {}

for (const sourceKind of ["scope", "layer"] as const) {
  test(`nested ${sourceKind} publication during setup releases its source without closing the invocation`, async () => {
    const order: string[] = [];
    const setup = Layer.effect(
      Ready,
      Effect.gen(function* () {
        const storage = yield* ArtifactStorage;
        const bytes = Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => order.push("source:acquire")),
            () => Effect.sync(() => order.push("source:release"))
          );
          yield* storage.publish(Json, "inner", { key: "inner" });
          return new Uint8Array([1, 2, 3]);
        });
        // A real Layer (not provideServiceEffect) so its own scope releases the source.
        const sourceLayer = Layer.effect(Source, bytes);
        const source =
          sourceKind === "scope"
            ? Effect.scoped(bytes)
            : Source.pipe(Effect.provide(sourceLayer));
        yield* storage.publish(Bytes, Stream.fromEffect(source), {
          key: "outer",
        });
        order.push("setup:published");
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const result = yield* Effect.result(
              storage.publish(Json, "too late", { key: "late" })
            );
            expect(result._tag).toBe("Failure");
            order.push("setup:release");
          })
        );
        return true;
      })
    );
    const task = Task.make(spec, () =>
      Effect.gen(function* () {
        const ready = yield* Ready;
        yield* (yield* ArtifactStorage).publish(Json, "handler", {
          key: "handler",
        });
        order.push("handler:published");
        return ready;
      })
    ).provide(setup);
    const result = await Effect.runPromise(Task.test(task, { input: null }));
    expect(result.value).toBe(true);
    expect(
      result.publications.map((publication) =>
        publication.kind === "json" ? publication.value : [...publication.bytes]
      )
    ).toEqual(["inner", [1, 2, 3], "handler"]);
    expect(order).toEqual([
      "source:acquire",
      "source:release",
      "setup:published",
      "handler:published",
      "setup:release",
    ]);
  });
}

for (const stop of ["failure", "timeout"] as const) {
  test(`nested source ${stop} cleans up without closing the setup that handles it`, async () => {
    const order: string[] = [];
    const started = Deferred.makeUnsafe<boolean>();
    const setup = Layer.effect(
      Ready,
      Effect.gen(function* () {
        const storage = yield* ArtifactStorage;
        const source = Stream.fromEffect(
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(Effect.void, () =>
                Effect.sync(() => order.push("source:release"))
              );
              yield* storage.publish(Json, "inner", { key: "inner" });
              yield* Deferred.succeed(started, true);
              return yield* stop === "failure"
                ? Effect.fail("source failed")
                : Effect.never;
            })
          )
        );
        const publish = storage.publish(Bytes, source, { key: "outer" });
        const result = yield* Effect.result(
          stop === "failure"
            ? publish
            : publish.pipe(
                Effect.raceFirst(
                  Deferred.await(started).pipe(
                    Effect.andThen(Effect.sleep(10)),
                    Effect.andThen(Effect.fail("caller timeout"))
                  )
                )
              )
        );
        expect(result._tag).toBe("Failure");
        expect(order).toEqual(["source:release"]);
        yield* storage.publish(Json, "after", { key: "after" });
        return true;
      })
    );
    const task = Task.make(spec, () => Ready).provide(setup);
    const result = await Effect.runPromise(Task.test(task, { input: null }));
    expect(result.publications.map((publication) => publication.value)).toEqual(
      ["inner", "after"]
    );
  });
}

test("capturing an operation Context does not suppress later acquisition-scope closure", async () => {
  const owner = publicationLifetime();
  const captured = await Effect.runPromise(owner.run(Effect.context()));
  await Effect.runPromise(
    Effect.scoped(owner.run(Effect.void).pipe(Effect.provideContext(captured)))
  );
  const late = await Effect.runPromise(Effect.result(owner.run(Effect.void)));
  expect(late._tag).toBe("Failure");
  if (late._tag === "Failure") {
    expect(late.failure.code).toBe("InvalidBoundary");
  }
});

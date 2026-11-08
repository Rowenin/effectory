# Invocation services and artifact tests

Use this reference after the basic authoring example when tasks need invocation-specific services or pass artifacts to other tasks. This is a separate complete application; do not paste it into the greeting application unchanged.

The measurement client below is an in-memory stand-in, not a third-party integration. Its lifecycle callback makes Layer acquisition and release observable in tests. A real adapter should use the supported Effect-native client Layer (Alchemy Distilled where capable) and let its Scope close the actual resource. Do not add an unused resource wrapper merely to imitate this example.

Create `effectory.ts`:

```ts
import {
  Application,
  Artifact,
  ArtifactReader,
  ArtifactReadError,
  ArtifactStorage,
  ArtifactUnavailable,
  Tag,
  Task,
  Workflow,
} from "@offtree/effectory-sdk";
import { Context, Effect, Layer, Option, Schema } from "effect";

export const Team = Tag.make("team", Schema.String);
export const Measurement = Artifact.make({
  id: "measurement",
  version: 1,
  schema: Schema.Struct({ count: Schema.Int, team: Schema.String }),
});
export class MeasurementClient extends Context.Service<
  MeasurementClient,
  {
    readonly measure: (
      count: number
    ) => Effect.Effect<typeof Measurement.schema.Type>;
  }
>()("example/MeasurementClient") {}

// An in-memory stand-in for a scoped client, with observable acquisition/release.
// A real client Layer would close its own socket, file, or pool in the finalizer.
export const measurementClient = (record: (event: string) => void) =>
  Layer.effect(
    MeasurementClient,
    Effect.gen(function* () {
      const team = Option.getOrElse(yield* Team.value(), () => "unclassified");
      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          record(`acquire:${team}`);
          return {
            measure: (count: number) => Effect.succeed({ count, team }),
          };
        }),
        () => Effect.sync(() => record(`release:${team}`))
      );
    })
  );

export const Produce = Task.make(
  {
    id: "measurement/produce",
    version: 1,
    input: Schema.Int,
    success: Measurement.refSchema,
    error: Schema.Never,
    replay: "idempotent",
    outputs: { measurement: Measurement },
  },
  (count) =>
    Effect.gen(function* () {
      const client = yield* MeasurementClient;
      const storage = yield* ArtifactStorage;
      return yield* storage.publish(Measurement, yield* client.measure(count), {
        key: "current",
      });
    })
);
const ReadErrors = Schema.Union([ArtifactReadError, ArtifactUnavailable]);
export const Consume = Task.make(
  {
    id: "measurement/consume",
    version: 1,
    input: Measurement.refSchema,
    success: Measurement.schema,
    error: ReadErrors,
    replay: "idempotent",
  },
  (reference) =>
    Effect.gen(function* () {
      const reader = yield* ArtifactReader;
      return yield* reader.get(Measurement, reference);
    })
);
const BoundProduce = Produce.provide(measurementClient(() => {}));
export const RoundTrip = Workflow.make(
  {
    id: "measurement/run",
    version: 1,
    input: Schema.Int,
    success: Measurement.schema,
    error: ReadErrors,
    tags: [Team],
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const reference = yield* graph.task(
      "produce",
      BoundProduce,
      yield* graph.input(Schema.Int)
    );
    return yield* graph.task("consume", Consume, reference, {
      retry: {
        attempts: 3,
        delay: "100 millis",
        when: ["ArtifactUnavailable"],
      },
    });
  })
);
export default Application.make({
  tasks: [BoundProduce, Consume],
  workflows: [RoundTrip],
}) satisfies Application.Application<never>;
```

The client Layer reads `Team.value()` during task acquisition, so it belongs on `Task.provide`. An application-level Layer is shared across runs and is the wrong owner for this invocation-specific value. `satisfies Application.Application<never>` checks that ordinary dependencies are supplied; the runner provides invocation services. The example computes deterministic content and publishes through Effectory, which justifies its idempotent replay policy. It does not demonstrate safe replay of an external mutation.

`tags: [Team]` declares an optional typed tag on this root workflow. It validates supplied values; it does not make the key required. `Team.value()` returns an Option, and the Layer handles absence explicitly. The metadata is also inherited by artifact publications. No environment-variable fallback is involved.

`Measurement` is declared in the producer's outputs. The consumer accepts its reference as input and yields `ArtifactReader`. Only `ArtifactUnavailable` is selected for retry; permanent `ArtifactReadError` failures remain failures. `Task.test` exercises one invocation and does not execute that graph-level retry policy.

Create `effectory.test.ts`:

```ts
import { expect, test } from "bun:test";

import { Task } from "@offtree/effectory-sdk";
import { Effect } from "effect";

import { Consume, Produce, Team, measurementClient } from "./effectory.ts";

test("task-local Layers read each invocation's tags and close before Task.test returns", async () => {
  const events: string[] = [];
  const producer = Produce.provide(
    measurementClient((event) => events.push(event))
  );
  const first = await Effect.runPromise(
    Task.test(producer, {
      input: 42,
      tags: [Team("platform")],
    })
  );
  expect(events).toEqual(["acquire:platform", "release:platform"]);
  const consumed = await Effect.runPromise(
    Task.test(Consume, {
      input: first.value,
      artifacts: first.artifacts,
    })
  );
  expect(consumed.value).toEqual({ count: 42, team: "platform" });
  expect(first.publications[0]?.tags).toEqual({ team: "platform" });

  // Thread prior artifacts into the next producer; don't concatenate independent stores.
  const second = await Effect.runPromise(
    Task.test(producer, {
      input: 7,
      tags: [Team("infra")],
      artifacts: first.artifacts,
    })
  );
  expect(events).toEqual([
    "acquire:platform",
    "release:platform",
    "acquire:infra",
    "release:infra",
  ]);
  expect(second.value.version).toBe(first.value.version + 1);
  const again = await Effect.runPromise(
    Task.test(Consume, {
      input: second.value,
      artifacts: second.artifacts,
    })
  );
  expect(again.value).toEqual({ count: 7, team: "infra" });
});

test("missing tags are handled at the read", async () => {
  const producer = Produce.provide(measurementClient(() => {}));
  const produced = await Effect.runPromise(Task.test(producer, { input: 1 }));
  const result = await Effect.runPromise(
    Task.test(Consume, {
      input: produced.value,
      artifacts: produced.artifacts,
    })
  );
  expect(result.value).toEqual({ count: 1, team: "unclassified" });
});
```

Keep the returned `artifacts` collection when chaining producer/consumer tests. A reference alone does not seed the next harness. Thread the previous collection through subsequent producer tests instead of concatenating independently created stores, whose synthetic identities can collide. Synthetic test references must not be submitted to the real daemon.

The second producer uses the same task/output/key identity, so it creates another version. In production, changing a key changes artifact identity; putting a different value under a key already used within the same invocation conflicts. Choose keys to reflect the intended version history, not as a way to disguise conflicting retries.

The tests check handler behavior, inherited labels and per-invocation Layers. They do not run workflow admission, persist reader pins, execute graph retries, prove process recovery or test real client cleanup. The example's exact application and tests were strictly typechecked against the workspace SDK and tested on the installed Effect library (two tests, seven assertions).

The exact application was separately exercised through the real CLI and daemon in a disposable repository. A run with input `7` and `--tag team=platform` succeeded with `{ count: 7, team: "platform" }`. After a graceful daemon stop/start, repeating its request key returned the original run. A new run with input `9` and `team=infra` created version 2 of the same artifact, with its own inherited tag. Passing version 1's real reference to `measurement/consume` still returned the original value. Both daemons exited cleanly. This checks admission, durable publication/read behavior and completed-run persistence across restart; it does not prove interrupted execution, retry-on-storage-error, retention during a wait, or real client cleanup. No authenticated agent session or registry installation was used.

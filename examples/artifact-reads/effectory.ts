import {
  Application,
  Artifact,
  ArtifactReader,
  ArtifactReadError,
  ArtifactUnavailable,
  ArtifactStorage,
  Task,
  Workflow,
} from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

const Measurement = Artifact.make({
  fields: [["count"]],
  id: "measurement",
  schema: Schema.Struct({ count: Schema.Int }),
  version: 1,
});
const Produce = Task.make(
  {
    error: Schema.Never,
    id: "produce",
    input: Schema.Int,
    outputs: { measurement: Measurement },
    replay: "idempotent",
    success: Measurement.refSchema,
    version: 1,
  },
  (count) =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      return yield* storage.publish(Measurement, { count }, { key: "current" });
    })
);
const Consume = Task.make(
  {
    error: Schema.Union([ArtifactReadError, ArtifactUnavailable]),
    id: "consume",
    input: Measurement.refSchema,
    replay: "idempotent",
    success: Schema.Int,
    version: 1,
  },
  (reference) =>
    Effect.gen(function* () {
      const reader = yield* ArtifactReader;
      const measurement = yield* reader.get(Measurement, reference);
      return measurement.count;
    })
);
const RoundTrip = Workflow.make(
  {
    error: Schema.Union([ArtifactReadError, ArtifactUnavailable]),
    id: "artifact-round-trip",
    input: Schema.Int,
    success: Schema.Int,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const reference = yield* graph.task(
      "produce",
      Produce,
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
  tasks: [Produce, Consume],
  workflows: [RoundTrip],
}) satisfies Application.Application<never>;

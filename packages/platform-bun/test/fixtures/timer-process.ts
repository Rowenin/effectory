import { Effect, Exit, Layer, Option, Schema } from "effect";
import { DurableClock, Workflow } from "effect/workflow";

import { engineLayer } from "../../src/engine.ts";
import { ownershipLayer } from "../../src/ownership.ts";
import { writeReady } from "./ready.ts";

const [filename, mode, readyFile] = process.argv.slice(2);
if (filename === undefined || mode === undefined || readyFile === undefined) {
  throw new Error("Expected database, mode and ready-file arguments");
}
const workflow = Workflow.make("EffectoryTimerProof", {
  idempotencyKey: ({ key }) => key,
  payload: { key: Schema.String },
  success: Schema.String,
});
const handler = workflow.toLayer(() =>
  DurableClock.sleep({
    duration: "3 seconds",
    inMemoryThreshold: 0,
    name: "short",
  }).pipe(Effect.as("awake"))
);
await Effect.runPromise(
  Effect.gen(function* () {
    const id = yield* workflow.execute({ key: "timer" }, { discard: true });
    if (mode === "cancel") {
      yield* workflow.interrupt(id);
    }
    for (let index = 0; index < 500; index += 1) {
      const result = yield* workflow.poll(id);
      if (Option.isSome(result)) {
        if (mode === "start" && result.value._tag === "Suspended") {
          yield* Effect.promise(
            async () =>
              await writeReady(
                readyFile,
                JSON.stringify({ duplicate: id, id, status: "Suspended" })
              )
          );
          return yield* Effect.never;
        }
        if (result.value._tag === "Complete") {
          const status = Exit.isSuccess(result.value.exit)
            ? "Succeeded"
            : "Cancelled";
          yield* Effect.promise(
            async () =>
              await writeReady(
                readyFile,
                JSON.stringify({ duplicate: id, id, status })
              )
          );
          return;
        }
      }
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die("Timer proof timed out");
  }).pipe(
    Effect.provide(
      handler.pipe(
        Layer.provideMerge(engineLayer(filename)),
        Layer.provide(ownershipLayer(`${filename}.owner`))
      )
    )
  )
);

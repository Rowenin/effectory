import * as BunServices from "@effect/platform-bun/BunServices";
import { Action, Engine, State } from "@effectory/core";
import type { Node } from "@effectory/core";
import { Effect, Layer } from "effect";

import * as Process from "../src/process.ts";

/** The Process service over Bun's platform services. */
export const processLayer = Process.layer.pipe(
  Layer.provide(BunServices.layer)
);

const engineLayer = Engine.layer.pipe(Layer.provideMerge(State.memory));
const collection = "std-test";

/**
 * Run `action` as a one-node workflow (`Action.toWorkflow`) on an in-memory
 * engine and return the run summary, its node, and the records written.
 */
export const runAction = <I, O, R>(
  action: Action.Action<string, I, O, R>,
  input: I,
  options: {
    readonly services: Layer.Layer<R>;
    readonly mode?: Node.Mode;
  }
) =>
  Effect.runPromise(
    Effect.gen(function* runActionTest() {
      const engine = yield* Engine.Engine;
      const state = yield* State.State;
      const summary = yield* engine.run(Action.toWorkflow(action), input, {
        collection,
        revision: "r1",
        ...(options.mode === undefined ? {} : { mode: options.mode }),
      });
      const records = yield* state.records({ collection });
      const node = summary.nodes.find((row) => row.fqn.endsWith("/run"));
      return { node, records, summary };
    }).pipe(Effect.provide(Layer.merge(engineLayer, options.services)))
  );

import { Effect, Stream } from "effect";

import { readFailure } from "./artifact-read-errors.ts";
import type { Service } from "./artifact-reader.ts";
import type { BinaryOwner } from "./binary-admission.ts";

export interface Binding {
  readonly reader: Service;
  readonly owner: BinaryOwner;
  readonly close: Effect.Effect<void>;
}
const bindings = new WeakMap<object, Binding>();
export const bindReader = (runtime: object, binding: Binding) => {
  bindings.set(runtime, binding);
};
export const readerBinding = (runtime: object) => bindings.get(runtime);
export const unavailableReader: Service = {
  bytes: () => Effect.fail(readFailure("Unsupported")),
  get: () => Effect.fail(readFailure("Unsupported")),
  latest: () => Effect.fail(readFailure("Unsupported")),
  metadata: () => Effect.fail(readFailure("Unsupported")),
  query: () => Effect.fail(readFailure("Unsupported")),
  stream: () => Stream.fail(readFailure("Unsupported")),
};

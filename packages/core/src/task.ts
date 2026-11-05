import { Effect, Layer } from "effect";
import type { Schema } from "effect";

import type * as Artifact from "./artifact.ts";
import { canonical, decode, encode, identifier, version } from "./boundary.ts";
import type { Boundary } from "./boundary.ts";
import { TaskRuntimeError } from "./errors.ts";
import { checkJsonBudget } from "./json-budget.ts";
import type { Occurrence } from "./schedule-occurrence.ts";
import { decodeTestOccurrence } from "./test-occurrence.ts";

export interface Spec {
  readonly id: string;
  readonly version: number;
  readonly input: Boundary;
  readonly success: Boundary;
  readonly error: Boundary;
  readonly replay: "idempotent" | "manual";
  readonly outputs?: Artifact.Outputs;
  readonly description?: string;
}

export type OutputsOf<S extends Spec> = S extends {
  readonly outputs: infer O extends Artifact.Outputs;
}
  ? O
  : Record<never, never>;

export interface PublicationOptions {
  readonly key: string;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface Progress {
  readonly message: string;
  readonly completed?: number;
  readonly total?: number;
}

export interface Identity {
  readonly runId: string;
  readonly invocationPath: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly revision: string;
  readonly attemptId: string;
  readonly attempt: number;
}

export interface RuntimeContext extends Identity {
  readonly occurrence?: typeof Occurrence.Type;
  readonly key: (name: string) => string;
  readonly publish: (
    name: string,
    artifact: Artifact.Artifact,
    value: Schema.Json,
    options: PublicationOptions
  ) => Effect.Effect<Artifact.Reference, TaskRuntimeError>;
  readonly progress: (update: Progress) => Effect.Effect<void>;
}

export interface TaskContext<O extends Artifact.Outputs> extends Identity {
  readonly occurrence?: typeof Occurrence.Type;
  readonly key: (name: string) => string;
  readonly publish: <K extends keyof O & string>(
    name: K,
    value: O[K]["schema"]["Type"],
    options: PublicationOptions
  ) => Effect.Effect<O[K]["refSchema"]["Type"], TaskRuntimeError>;
  readonly progress: (update: Progress) => Effect.Effect<void>;
}

export interface Contract<S extends Spec = Spec> {
  readonly kind: "Task";
  readonly spec: S;
  readonly id: S["id"];
  readonly inputSchema: S["input"];
  readonly successSchema: S["success"];
  readonly errorSchema: S["error"];
}

export interface Definition<
  S extends Spec = Spec,
  R = never,
> extends Contract<S> {
  readonly execute: (
    input: unknown,
    context: RuntimeContext
  ) => Effect.Effect<
    S["success"]["Type"],
    S["error"]["Type"] | TaskRuntimeError,
    R
  >;
  readonly provide: <ROut, E, RIn>(
    layer: Layer.Layer<ROut, E, RIn>
  ) => Definition<S, Exclude<R, ROut> | RIn>;
}

export function contract<const S extends Spec>(spec: S): Contract<S> {
  identifier(spec.id);
  version(spec.version);
  return Object.freeze({
    errorSchema: spec.error,
    id: spec.id,
    inputSchema: spec.input,
    kind: "Task",
    spec,
    successSchema: spec.success,
  });
}

function boundary<A>(action: () => A): Effect.Effect<A, TaskRuntimeError> {
  return Effect.try({
    catch: (error) =>
      error instanceof TaskRuntimeError
        ? error
        : new TaskRuntimeError({
            code: "InvalidBoundary",
            message: "Task boundary validation failed",
          }),
    try: action,
  });
}

function contextFor<O extends Artifact.Outputs>(
  outputs: O,
  runtime: RuntimeContext
): TaskContext<O> {
  return {
    ...runtime,
    publish: (name, value, options) => {
      const artifact = outputs[name];
      if (!artifact) {
        return Effect.fail(
          new TaskRuntimeError({
            code: "UnknownOutput",
            message: `Undeclared output: ${name}`,
          })
        );
      }
      return Effect.gen(function* () {
        const encoded = yield* boundary(() => {
          identifier(options.key);
          const payload = encode(artifact.schema, value);
          checkJsonBudget(payload);
          return payload;
        });
        const reference = yield* runtime.publish(
          name,
          artifact,
          encoded,
          options
        );
        return yield* boundary(() => decode(artifact.refSchema, reference));
      });
    },
  };
}

function definition<S extends Spec, R>(
  spec: S,
  execute: Definition<S, R>["execute"]
): Definition<S, R> {
  return Object.freeze({
    ...contract(spec),
    execute,
    provide: <ROut, E, RIn>(layer: Layer.Layer<ROut, E, RIn>) =>
      definition(spec, (input, context) =>
        execute(input, context).pipe(Effect.provide(Layer.orDie(layer)))
      ),
  });
}

export function make<const S extends Spec, R>(
  spec: S,
  handler: (
    input: NoInfer<S["input"]["Type"]>,
    context: TaskContext<OutputsOf<NoInfer<S>>>
  ) => Effect.Effect<
    NoInfer<S["success"]["Type"]>,
    NoInfer<S["error"]["Type"]> | TaskRuntimeError,
    R
  >
): Definition<S, R> {
  // This assertion relates the conditional output type to the optional field;
  // publication still checks the actual output table and codec at runtime.
  const outputs = (spec.outputs ?? {}) as OutputsOf<S>;
  return definition(spec, (encodedInput, runtime) =>
    Effect.gen(function* () {
      const input = yield* boundary(() => {
        checkJsonBudget(encodedInput);
        return decode(spec.input, encodedInput);
      });
      const result = yield* handler(input, contextFor(outputs, runtime)).pipe(
        Effect.catch((error) =>
          error instanceof TaskRuntimeError
            ? Effect.fail(error)
            : boundary(() => {
                const encodedError = encode(spec.error, error);
                checkJsonBudget(encodedError);
                return encodedError;
              }).pipe(Effect.andThen(Effect.fail(error)))
        )
      );
      yield* boundary(() => checkJsonBudget(encode(spec.success, result)));
      return result;
    })
  );
}

export interface TestPublication {
  readonly output: string;
  readonly value: Schema.Json;
  readonly reference: Artifact.Reference;
}

/** Bind an implementation to the exact existing contract, without changing codecs. */
export interface Implementation<
  S extends Spec = Spec,
  R = never,
  Id extends string = string,
> extends Definition<S, R> {
  readonly providerId: Id;
  readonly provide: <ROut, E, RIn>(
    layer: Layer.Layer<ROut, E, RIn>
  ) => Implementation<S, Exclude<R, ROut> | RIn, Id>;
}

function providerDefinition<S extends Spec, R, Id extends string>(
  id: Id,
  base: Definition<S, R>
): Implementation<S, R, Id> {
  return Object.freeze({
    ...base,
    provide: <ROut, E, RIn>(layer: Layer.Layer<ROut, E, RIn>) =>
      providerDefinition(id, base.provide(layer)),
    providerId: id,
  });
}

export function implementation<
  const S extends Spec,
  R,
  const Id extends string = string,
>(
  provider: { readonly id: Id; readonly target: Contract<S> },
  handler: Parameters<typeof make<S, R>>[1]
): Implementation<S, R, Id> {
  identifier(provider.id);
  return providerDefinition(provider.id, make(provider.target.spec, handler));
}

/** One validated attempt with fake host capabilities; not a durability test. */
export function test<S extends Spec, R>(
  task: Definition<S, R>,
  options: {
    readonly input: NoInfer<S["input"]["Type"]>;
    readonly occurrence?: typeof Occurrence.Type;
  }
) {
  return Effect.suspend(() => {
    const publications: TestPublication[] = [];
    const progress: Progress[] = [];
    const keys = new Map<
      string,
      { readonly fingerprint: string; readonly reference: Artifact.Reference }
    >();
    const runtime: RuntimeContext = {
      attempt: 1,
      attemptId: "test-attempt",
      invocationPath: "task",
      key: (name) => `test-run/task/${identifier(name)}`,
      progress: (update) =>
        Effect.sync(() => {
          progress.push(update);
        }),
      publish: (name, artifact, value, publication) =>
        Effect.gen(function* () {
          const key = `${name}/${publication.key}`;
          const fingerprint = canonical({
            tags: publication.tags ?? {},
            value,
          });
          const prior = keys.get(key);
          if (prior) {
            if (prior.fingerprint !== fingerprint) {
              return yield* new TaskRuntimeError({
                code: "PublicationConflict",
                message: `Changed publication: ${key}`,
              });
            }
            return prior.reference;
          }
          const reference = {
            artifactId: `test-artifact-${publications.length + 1}`,
            digest: `test-digest-${publications.length + 1}`,
            schemaId: artifact.id,
            schemaVersion: artifact.version,
            version: 1,
          };
          keys.set(key, { fingerprint, reference });
          publications.push({ output: name, reference, value });
          return reference;
        }),
      revision: "test-revision",
      runId: "test-run",
      taskId: task.id,
      taskVersion: task.spec.version,
    };
    return Effect.gen(function* () {
      const occurrence =
        "occurrence" in options
          ? yield* decodeTestOccurrence(options.occurrence)
          : undefined;
      const input = yield* boundary(() =>
        encode(task.inputSchema, options.input)
      );
      const value = yield* task.execute(
        input,
        occurrence === undefined ? runtime : { ...runtime, occurrence }
      );
      return {
        progress: Object.freeze(progress),
        publications: Object.freeze(publications),
        value,
      };
    });
  });
}

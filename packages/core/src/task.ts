import {
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
  Semaphore,
} from "effect";

import {
  bindReader,
  readerBinding,
  unavailableReader,
} from "./artifact-reader-state.ts";
import { ArtifactReader } from "./artifact-reader.ts";
import { ArtifactStorage } from "./artifact-storage.ts";
import type { PublishOptions } from "./artifact-storage.ts";
import { artifactTestStore } from "./artifact-test-store.ts";
import type * as Artifact from "./artifact.ts";
import {
  canonical,
  decode,
  encode,
  identifier,
  mapFailureCause,
  version,
} from "./boundary.ts";
import type { Boundary } from "./boundary.ts";
import type { Severity } from "./check-schema.ts";
import { bindChecks, checksFor, testChecks } from "./check-state.ts";
import { Checks } from "./checks.ts";
import { TaskRuntimeError } from "./errors.ts";
import { checkJsonBudget } from "./json-budget.ts";
import { publicationLifetime } from "./publication-lifetime.ts";
import { History } from "./report-history.ts";
import { historyFor } from "./report-state.ts";
import type { Occurrence } from "./schedule-occurrence.ts";
import { normalize, snapshot } from "./tag-state.ts";
import * as Tag from "./tag.ts";
import { decodeTestOccurrence } from "./test-occurrence.ts";
import * as VaultTracker from "./vault-tracker.ts";

/** Publication options detached from caller-owned objects by a JSON round trip. */
const OwnedPublication = Schema.Struct({
  key: Schema.String,
  tags: Schema.Record(Schema.String, Schema.String),
});
const OwnedJsonPublication = Schema.Struct({
  ...OwnedPublication.fields,
  value: Schema.Json,
});

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
  : // oxlint-disable-next-line typescript/no-generated-empty-object-type -- a {} default keeps keyof inference in the public API
    Record<never, never>;

export interface PublicationOptions {
  readonly key: string;
  readonly tags?: Tag.Input;
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
  readonly tags?: Readonly<Record<string, string>>;
  readonly occurrence?: typeof Occurrence.Type;
  readonly key: (name: string) => string;
  readonly publish: (
    name: string,
    artifact: Artifact.Artifact,
    value: Schema.Json,
    options: {
      readonly key: string;
      readonly tags?: Readonly<Record<string, string>>;
    }
  ) => Effect.Effect<Artifact.Reference, TaskRuntimeError>;
  readonly publishBytes?: <E = never, R = never>(
    name: string,
    artifact: Artifact.Bytes,
    source: Stream.Stream<Uint8Array, E, R>,
    options: {
      readonly key: string;
      readonly tags?: Readonly<Record<string, string>>;
    }
  ) => Effect.Effect<Artifact.Reference, E | TaskRuntimeError, R>;
  readonly progress: (update: Progress) => Effect.Effect<void>;
}

export interface TaskContext<O extends Artifact.Outputs> extends Identity {
  readonly tags: Readonly<Record<string, string>>;
  readonly occurrence?: typeof Occurrence.Type;
  readonly key: (name: string) => string;
  readonly publish: <K extends keyof O & string>(
    name: K,
    value: O[K] extends Artifact.Artifact ? O[K]["schema"]["Type"] : never,
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
  ) => Definition<
    S,
    Exclude<
      Exclude<R, ROut> | RIn,
      Tag.Values | ArtifactStorage | History | ArtifactReader | Checks
    >
  >;
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

function tagBoundary<A>(action: () => A): Effect.Effect<A, TaskRuntimeError> {
  return Effect.try({
    catch: (error) =>
      error instanceof TaskRuntimeError
        ? error
        : new TaskRuntimeError({
            code: "InvalidBoundary",
            message: `Invalid tags: ${String(error).slice(0, 1700)}`,
          }),
    try: action,
  });
}

function publicationTags(
  inherited: Readonly<Record<string, string>>,
  options: PublicationOptions
) {
  return tagBoundary(() => {
    const explicit = "tags" in options ? normalize(options.tags, true) : {};
    const merged = Object.freeze({ ...inherited, ...explicit });
    if (new TextEncoder().encode(JSON.stringify(merged)).byteLength > 8192) {
      throw new TaskRuntimeError({
        code: "LimitExceeded",
        message:
          "Inherited run tags plus explicit publication tags exceed 8192 bytes",
      });
    }
    return merged;
  });
}

function taskLayer<A, E, R, S extends Boundary>(
  layer: Layer.Layer<A, E, R>,
  close: Effect.Effect<void>,
  errorSchema: S
) {
  return layer.pipe(
    Layer.tap(() => Effect.addFinalizer(() => close)),
    // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Effect Layer recovery, not a Promise callback.
    Layer.catchCause((cause): Layer.Layer<A, TaskRuntimeError | S["Type"]> =>
      Layer.effectContext(
        // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Maps an Effect Cause, not a Promise callback.
        mapFailureCause(cause, (error) =>
          error instanceof TaskRuntimeError || Schema.is(errorSchema)(error)
            ? Effect.fail(error)
            : Effect.die(error)
        ).pipe(Effect.flatMap(Effect.failCause))
      )
    )
  );
}

function contextFor(
  outputs: Artifact.Outputs,
  runtime: RuntimeContext & { readonly tags: Readonly<Record<string, string>> }
): {
  readonly publish: (
    name: string,
    value: unknown,
    options: PublicationOptions
  ) => Effect.Effect<Artifact.Reference, TaskRuntimeError>;
} {
  return {
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
      if (artifact.kind === "bytes") {
        return Effect.fail(
          new TaskRuntimeError({
            code: "InvalidBoundary",
            message: "Use ArtifactStorage.publish for bytes artifacts",
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
        const tags = yield* publicationTags(runtime.tags, options);
        const serialized = JSON.stringify({
          key: options.key,
          tags,
          value: encoded,
        });
        yield* VaultTracker.checkSerialized(serialized);
        const owned = yield* Schema.decodeUnknownEffect(OwnedJsonPublication)(
          JSON.parse(serialized)
        ).pipe(Effect.orDie);
        const reference = yield* runtime.publish(name, artifact, owned.value, {
          key: owned.key,
          tags: owned.tags,
        });
        return yield* boundary(() => decode(artifact.refSchema, reference));
      });
    },
  };
}

type Storage = typeof ArtifactStorage.Service;
type Invocation = ReturnType<typeof publicationLifetime> & {
  readonly storage: Storage;
};

function storageFor(
  outputs: Artifact.Outputs,
  runtime: RuntimeContext & { readonly tags: Readonly<Record<string, string>> },
  lifetime: ReturnType<typeof publicationLifetime>
): Storage {
  const publisher = contextFor(outputs, runtime);
  return ArtifactStorage.of({
    publish: <A extends Artifact.Any, E = never, R = never>(
      artifact: A,
      value: A["kind"] extends "bytes"
        ? Uint8Array | Stream.Stream<Uint8Array, E, R>
        : NoInfer<(A & Artifact.Artifact)["schema"]["Type"]>,
      options: PublishOptions
    ): Effect.Effect<A["refSchema"]["Type"], E | TaskRuntimeError, R> =>
      lifetime.run(
        Effect.suspend(() => {
          const names = Object.keys(outputs).filter(
            (name) => outputs[name] === artifact
          );
          const name =
            options.output ?? (names.length === 1 ? names[0] : undefined);
          if (
            names.length === 0 ||
            (name !== undefined && outputs[name] !== artifact)
          ) {
            const duplicate = Object.values(outputs).some(
              (declared) => declared.id === artifact.id && declared !== artifact
            );
            return Effect.fail(
              new TaskRuntimeError({
                code: "UnknownOutput",
                message: `Task ${runtime.taskId} does not declare this output for ${artifact.id}${duplicate ? "; same id, different definition instance; check duplicate module copies" : ""}`,
              })
            );
          }
          if (name === undefined) {
            return Effect.fail(
              new TaskRuntimeError({
                code: "InvalidBoundary",
                message: `Artifact ${artifact.id} has multiple output aliases; specify output: ${names.join(", ")}`,
              })
            );
          }
          if (artifact.kind === "json") {
            return publisher.publish(name, value, options);
          }
          const publish = runtime.publishBytes;
          if (!publish) {
            return Effect.fail(
              new TaskRuntimeError({
                code: "InvalidBoundary",
                message:
                  "This task runtime does not support binary artifacts; provide publishBytes or upgrade the host",
              })
            );
          }
          // Runtime discrimination narrows the artifact, but TypeScript cannot
          // narrow the conditional value. These casts retain the source E/R.
          const source = Stream.isStream(value)
            ? // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion, typescript/no-unsafe-type-assertion -- user code loaded at runtime has an unknown error type; the checker cannot relate this erased generic
              (value as Stream.Stream<Uint8Array, E, R>)
            : // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the checker cannot relate this erased generic
              Stream.succeed(value as Uint8Array);
          return Effect.gen(function* () {
            yield* boundary(() => identifier(options.key));
            const tags = yield* publicationTags(runtime.tags, options);
            const serialized = JSON.stringify({ key: options.key, tags });
            yield* VaultTracker.checkSerialized(serialized);
            const owned = yield* Schema.decodeUnknownEffect(OwnedPublication)(
              JSON.parse(serialized)
            ).pipe(Effect.orDie);
            const reference = yield* publish(name, artifact, source, owned);
            return yield* boundary(() => decode(artifact.refSchema, reference));
          });
        })
      ),
  });
}

function legacyContext<O extends Artifact.Outputs>(
  outputs: O,
  runtime: RuntimeContext & { readonly tags: Readonly<Record<string, string>> },
  fallback: Storage
): TaskContext<O> {
  return {
    ...runtime,
    publish: (name, value, options) =>
      Effect.gen(function* () {
        const artifact = outputs[name];
        if (!artifact) {
          return yield* new TaskRuntimeError({
            code: "UnknownOutput",
            message: `Undeclared output: ${name}`,
          });
        }
        if (artifact.kind === "bytes") {
          return yield* new TaskRuntimeError({
            code: "InvalidBoundary",
            message: "Use ArtifactStorage.publish for bytes artifacts",
          });
        }
        const service = yield* Effect.serviceOption(ArtifactStorage);
        const storage = Option.getOrElse(service, () => fallback);
        return yield* storage.publish<Artifact.Artifact>(artifact, value, {
          ...options,
          output: name,
        });
      }),
  };
}

function definition<S extends Spec, R>(
  spec: S,
  execute: (
    input: unknown,
    runtime: RuntimeContext & {
      readonly tags: Readonly<Record<string, string>>;
    },
    invocation: Invocation
  ) => Effect.Effect<
    S["success"]["Type"],
    S["error"]["Type"] | TaskRuntimeError,
    R
  >
): Definition<
  S,
  Exclude<R, Tag.Values | ArtifactStorage | History | ArtifactReader | Checks>
> {
  return Object.freeze({
    ...contract(spec),
    execute: (input: unknown, runtime: RuntimeContext) =>
      Effect.gen(function* () {
        const tags = yield* tagBoundary(() =>
          snapshot("tags" in runtime ? runtime.tags : {})
        );
        const tracker = yield* VaultTracker.Invocation;
        const runtimeSnapshot = {
          ...runtime,
          progress: (update: Progress) =>
            runtime.progress({
              ...update,
              message: VaultTracker.scrub(tracker, update.message),
            }),
          tags,
        };
        const binding = readerBinding(runtime);
        const lifetime = publicationLifetime(binding?.close);
        const storage = storageFor(
          spec.outputs ?? {},
          runtimeSnapshot,
          lifetime
        );
        return yield* execute(input, runtimeSnapshot, {
          ...lifetime,
          storage,
        }).pipe(
          Effect.ensuring(lifetime.close),
          Effect.ensuring(
            Effect.sync(() => {
              if (tracker) {
                VaultTracker.close(tracker);
              }
            })
          ),
          Effect.provideService(Layer.CurrentMemoMap, lifetime.memoMap),
          Effect.provideContext(
            Context.make(ArtifactStorage, storage).pipe(
              Context.add(Tag.Values, tags),
              Context.add(Checks, checksFor(runtime, lifetime, tracker)),
              Context.add(History, historyFor(runtime)),
              Context.add(ArtifactReader, binding?.reader ?? unavailableReader)
            )
          ),
          // Validate after every task-local Layer has released: acquisition can
          // fail before the handler, and finalizers can register new secrets.
          Effect.catchCause((cause) =>
            mapFailureCause(cause, (error) =>
              error instanceof TaskRuntimeError
                ? Effect.fail(
                    new TaskRuntimeError({
                      code: error.code,
                      message: VaultTracker.scrub(tracker, error.message),
                    })
                  )
                : boundary(() => {
                    const encoded = encode(spec.error, error);
                    checkJsonBudget(encoded);
                    return JSON.stringify(encoded);
                  }).pipe(
                    Effect.tap((encoded) =>
                      VaultTracker.checkSerialized(encoded, tracker)
                    ),
                    Effect.andThen(Effect.fail(error))
                  )
            ).pipe(Effect.flatMap(Effect.failCause))
          ),
          Effect.tap((result) =>
            boundary(() => {
              const encoded = encode(spec.success, result);
              checkJsonBudget(encoded);
              return JSON.stringify(encoded);
            }).pipe(
              Effect.flatMap((encoded) =>
                VaultTracker.checkSerialized(encoded, tracker)
              )
            )
          )
        );
      }),
    provide: <ROut, E, RIn>(layer: Layer.Layer<ROut, E, RIn>) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the checker cannot relate this erased generic
      definition(
        spec,
        (input, context, invocation) =>
          Effect.scoped(
            Effect.gen(function* () {
              const scope = yield* Effect.scope;
              const services = yield* Layer.buildWithMemoMap(
                taskLayer<ROut, E, RIn, S["error"]>(
                  layer,
                  invocation.close,
                  spec.error
                ),
                invocation.memoMap,
                scope
              );
              return yield* execute(input, context, invocation).pipe(
                Effect.ensuring(invocation.close),
                Effect.provideContext(services)
              );
            })
          )
        // Excluding runner-owned Values commutes with excluding the Layer's outputs.
      ) as Definition<
        S,
        Exclude<
          | Exclude<
              Exclude<
                R,
                Tag.Values | ArtifactStorage | History | ArtifactReader | Checks
              >,
              ROut
            >
          | RIn,
          Tag.Values | ArtifactStorage | History | ArtifactReader | Checks
        >
      >,
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
): Definition<
  S,
  Exclude<R, Tag.Values | ArtifactStorage | History | ArtifactReader | Checks>
> {
  // This assertion relates the conditional output type to the optional field;
  // publication still checks the actual output table and codec at runtime.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the checker cannot relate this erased generic
  const outputs = (spec.outputs ?? {}) as OutputsOf<S>;
  return definition(spec, (encodedInput, runtime, invocation) =>
    Effect.gen(function* () {
      const input = yield* boundary(() => {
        checkJsonBudget(encodedInput);
        return decode(spec.input, encodedInput);
      });
      invocation.beginHandler();
      return yield* handler(
        input,
        legacyContext(outputs, runtime, invocation.storage)
      );
    })
  );
}

interface TestPublicationBase {
  readonly tags: Readonly<Record<string, string>>;
  readonly output: string;
  readonly reference: Artifact.Reference;
}

export type TestPublication = TestPublicationBase &
  (
    | { readonly kind: "json"; readonly value: Schema.Json }
    | {
        readonly kind: "bytes";
        readonly value?: never;
        readonly contentType: string;
        readonly bytes: Uint8Array;
        readonly sha256: string;
        readonly byteLength: number;
      }
  );

/** Bind an implementation to the exact existing contract, without changing codecs. */
export interface Implementation<
  S extends Spec = Spec,
  R = never,
  Id extends string = string,
> extends Definition<S, R> {
  readonly providerId: Id;
  readonly provide: <ROut, E, RIn>(
    layer: Layer.Layer<ROut, E, RIn>
  ) => Implementation<
    S,
    Exclude<
      Exclude<R, ROut> | RIn,
      Tag.Values | ArtifactStorage | History | ArtifactReader | Checks
    >,
    Id
  >;
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
): Implementation<
  S,
  Exclude<R, Tag.Values | ArtifactStorage | History | ArtifactReader | Checks>,
  Id
> {
  identifier(provider.id);
  return providerDefinition(provider.id, make(provider.target.spec, handler));
}

/** One validated attempt with fake host capabilities; not a durability test. */
export function test<S extends Spec, R>(
  task: Definition<S, R>,
  options: {
    readonly artifacts?: readonly Artifact.Fixture[];
    readonly checks?: { readonly failOn?: Severity };
    readonly input: NoInfer<S["input"]["Type"]>;
    readonly occurrence?: typeof Occurrence.Type;
    readonly tags?: Tag.Input;
  }
) {
  return Effect.gen(function* () {
    const artifacts = yield* boundary(() =>
      artifactTestStore(options.artifacts)
    );
    const writers = Semaphore.makeUnsafe(4);
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
          const reference = yield* artifacts.publish(
            artifact,
            canonical(value),
            {
              attemptId: "test-attempt",
              invocationPath: "task",
              key: publication.key,
              output: name,
              revision: "test-revision",
              runId: "test-run",
              tags: publication.tags ?? {},
              taskId: task.id,
            }
          );
          keys.set(key, { fingerprint, reference });
          publications.push({
            kind: "json",
            output: name,
            reference,
            tags: publication.tags ?? {},
            value,
          });
          return reference;
        }),
      publishBytes: (name, artifact, source, publication) =>
        Effect.gen(function* () {
          const chunks: Uint8Array[] = [];
          let byteLength = 0;
          yield* Stream.runForEach(source, (chunk) =>
            Effect.suspend(() => {
              if (!(chunk instanceof Uint8Array)) {
                return Effect.fail(
                  new TaskRuntimeError({
                    code: "InvalidBoundary",
                    message: "Binary sources must emit Uint8Array chunks",
                  })
                );
              }
              byteLength += chunk.byteLength;
              if (byteLength > 16_777_216) {
                return Effect.fail(
                  new TaskRuntimeError({
                    code: "LimitExceeded",
                    message: "Binary artifact exceeds 16 MiB",
                  })
                );
              }
              // Retained harness records own their content even if a producer
              // reuses buffers for later chunks or mutates them after publishing.
              chunks.push(new Uint8Array(chunk));
              return Effect.void;
            })
          );
          const bytes = new Uint8Array(byteLength);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const digest = yield* Effect.promise(
            async () => await crypto.subtle.digest("SHA-256", bytes)
          );
          const sha256 = [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          const key = `${name}/${publication.key}`;
          const fingerprint = canonical({
            contentType: artifact.contentType,
            sha256,
            tags: publication.tags ?? {},
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
          const reference = yield* artifacts.publish(artifact, bytes, {
            attemptId: "test-attempt",
            invocationPath: "task",
            key: publication.key,
            output: name,
            revision: "test-revision",
            runId: "test-run",
            tags: publication.tags ?? {},
            taskId: task.id,
          });
          keys.set(key, { fingerprint, reference });
          publications.push({
            byteLength,
            bytes,
            contentType: artifact.contentType,
            kind: "bytes",
            output: name,
            reference,
            sha256,
            tags: publication.tags ?? {},
          });
          return reference;
        }),
      revision: "test-revision",
      runId: "test-run",
      taskId: task.id,
      taskVersion: task.spec.version,
    };
    const { publishBytes } = runtime;
    if (!publishBytes) {
      return yield* new TaskRuntimeError({
        code: "InvalidBoundary",
        message: "Test binary publisher unavailable",
      });
    }
    const runtimeWithOwner = {
      ...runtime,
      publishBytes: <E, Services>(
        name: string,
        artifact: Artifact.Bytes,
        source: Stream.Stream<Uint8Array, E, Services>,
        publication: Parameters<RuntimeContext["publish"]>[3]
      ) =>
        artifacts.binding.owner.publish(
          writers.withPermits(1)(
            publishBytes(name, artifact, source, publication)
          )
        ),
    };
    return yield* VaultTracker.protect(() =>
      Effect.gen(function* () {
        const tags = yield* tagBoundary(() =>
          normalize("tags" in options ? options.tags : {})
        );
        const occurrence =
          "occurrence" in options
            ? yield* decodeTestOccurrence(options.occurrence)
            : undefined;
        const input = yield* boundary(() =>
          encode(task.inputSchema, options.input)
        );
        const invocationRuntime = {
          ...runtimeWithOwner,
          tags,
          ...(occurrence === undefined ? {} : { occurrence }),
        };
        bindReader(invocationRuntime, artifacts.binding);
        const checks = yield* boundary(() =>
          testChecks(
            invocationRuntime,
            "checks" in options ? options.checks : {}
          )
        );
        bindChecks(invocationRuntime, checks.binding);
        const value = yield* task.execute(input, invocationRuntime);
        return {
          artifacts: artifacts.artifacts(),
          checks: checks.records(),
          progress: Object.freeze(progress),
          publications: Object.freeze(publications),
          value,
        };
      })
    );
  });
}

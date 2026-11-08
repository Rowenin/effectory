/* oxlint-disable max-classes-per-file -- Independent test-local Effect service identities. */
import { describe, expect, test } from "bun:test";

import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";

import {
  Application,
  Artifact,
  ArtifactStorage,
  Task,
  Vault,
} from "../src/index.ts";
import { building, protect } from "../src/vault-tracker.ts";

const A = Vault.make({
  id: "test/a",
  secrets: { count: Schema.FiniteFromString, token: Schema.NonEmptyString },
});
const B = Vault.make({ id: "test/b", secrets: { token: Schema.String } });
const canary = "CANARY-vault-12345678";
const provider = Vault.layer(A, Vault.memory({ count: "42", token: canary }));
const spec = {
  error: Vault.Errors,
  id: "test/vault",
  input: Schema.Struct({}),
  replay: "idempotent" as const,
  success: Schema.String,
  version: 1,
};
const run = <S extends Task.Spec, R>(task: Task.Definition<S, R>) =>
  Task.test(task, { input: {} });

const failure = async <A, E>(program: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(program);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    throw new Error("expected failure");
  }
  return `${Cause.pretty(exit.cause)}\n${JSON.stringify(exit.cause)}`;
};

describe("vault contracts", () => {
  test("two independent providers, typed decoding and absent values", async () => {
    const values = await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* A.get("count");
        const b = yield* B.get("token");
        return [
          Redacted.value(a),
          Redacted.value(b),
          yield* A.getOption("token"),
        ] as const;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Vault.layer(A, Vault.memory({ count: "42" })),
            Vault.layer(B, Vault.memory({ token: "remote-token" }))
          )
        )
      )
    );
    expect(values[0]).toBe(42);
    expect(values[1]).toBe("remote-token");
    expect(Option.isNone(values[2])).toBe(true);
  });
  test("test harness refuses secret results and artifact metadata", async () => {
    const task = Task.make(spec, () =>
      Effect.map(A.get("token"), Redacted.value)
    );
    const message = await failure(run(task).pipe(Effect.provide(provider)));
    expect(message).toContain("SecretInOutput");
    expect(message).not.toContain(canary);
    const report = Artifact.make({
      id: "test/report",
      schema: Schema.String,
      version: 1,
    });
    const publish = Task.make({ ...spec, outputs: { report } }, () =>
      Effect.gen(function* () {
        const token = Redacted.value(yield* A.get("token"));
        yield* (yield* ArtifactStorage).publish(report, "safe", {
          key: "report",
          tags: { token },
        });
        return "done";
      })
    );
    expect(
      await failure(run(publish).pipe(Effect.provide(provider)))
    ).toContain("SecretInOutput");
  });
  test("progress redacts before recording; normal output is retained", async () => {
    const task = Task.make(spec, (_, context) =>
      Effect.gen(function* () {
        const token = Redacted.value(yield* A.get("token"));
        yield* context.progress({ message: `header=${token}` });
        return "done";
      })
    );
    const result = await Effect.runPromise(
      run(task).pipe(Effect.provide(provider))
    );
    expect(result.value).toBe("done");
    expect(result.progress[0]?.message).toBe("[vault secret omitted]");
  });
  test("duplicate IDs fail registration and separate instances do not share services", async () => {
    const duplicate = Vault.make({
      id: "test/a",
      secrets: { token: Schema.String },
    });
    const app = Application.make({ vaults: [A, duplicate] }).provide(
      Layer.mergeAll(
        provider,
        Vault.layer(duplicate, Vault.memory({ token: "other" }))
      )
    );
    expect(await failure(Effect.scoped(Layer.build(app.layer)))).toContain(
      "noncanonical vault"
    );
    expect(A.key).not.toBe(duplicate.key);
  });
  test("host handles reject fresh roots but captured build contexts preserve invocation", async () => {
    class Client extends Context.Service<
      Client,
      { read: Effect.Effect<string, Vault.ReadError> }
    >()("test/VaultClient") {}
    const client = Layer.effect(
      Client,
      Effect.gen(function* () {
        const handle = yield* A;
        const services = yield* Effect.context();
        return {
          read: handle
            .get("token")
            .pipe(Effect.as("safe"), Effect.provideContext(services)),
        };
      })
    ).pipe(Layer.provideMerge(provider));
    const task = Task.make(spec, () => Effect.flatMap(Client, (c) => c.read));
    const app = Application.make({ tasks: [task], vaults: [A] }).provide(
      client
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* building(Layer.build(app.layer));
          const handle = Context.get(context, Application.Registry);
          const runtime = handle.tasks.get(task.id);
          if (!runtime) {
            throw new Error("Missing registered task");
          }
          return yield* protect(() =>
            // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- user code loaded at runtime has an unknown error type
            runtime.execute(
              {},
              {
                attempt: 1,
                attemptId: "a",
                invocationPath: "task",
                key: (k) => k,
                progress: () => Effect.void,
                publish: () => Effect.die("unused"),
                revision: "r",
                runId: "run",
                taskId: task.id,
                taskVersion: 1,
              }
            )
          );
        })
      )
    );
    expect(result).toBe("safe");
    const escaped = Task.make(spec, () =>
      Effect.gen(function* () {
        const handle = yield* A;
        // The escape under test is a fresh root without the task's context.
        return yield* Effect.promise(
          async () =>
            // @effect-diagnostics-next-line runEffectInsideEffect:off
            await Effect.runPromise(
              Effect.map(handle.get("token"), Redacted.value)
            )
        );
      })
    ).provide(provider);
    expect(await failure(run(escaped))).toContain("Unmanaged");
  });
  test("build-time reads and eager throwing decoders fail without leaking", async () => {
    expect(
      await failure(building(A.get("token").pipe(Effect.provide(provider))))
    ).toContain("Unmanaged");
    const bad = Vault.make({
      id: "bad",
      secrets: {
        token: Schema.String.check(
          Schema.makeFilter(() => {
            throw new Error(canary);
          })
        ),
      },
    });
    const result = await failure(
      bad
        .get("token")
        .pipe(Effect.provide(Vault.layer(bad, Vault.memory({ token: canary }))))
    );
    expect(result).toContain("DecoderFailed");
    expect(result).not.toContain(canary);
  });
});

// Compiler proofs preserve separate requirements and decoded types.
const typed: Effect.Effect<
  Redacted.Redacted<number>,
  Vault.ReadError,
  typeof A
> = A.get("count");
void typed;
// @ts-expect-error undeclared secret name
const missing = A.get("missing");
void missing;
// @ts-expect-error hand-written handles are not branded
Layer.succeed(A, {
  get: () => Effect.succeed(Redacted.make("fake")),
  getOption: () => Effect.succeedNone,
});

test("task-local Layer failures retain declared vault errors; finalizers may read", async () => {
  class Client extends Context.Service<Client, string>()(
    "test/VaultLayerClient"
  ) {}
  const unavailable: Vault.Implementation = () =>
    Effect.succeed({
      providerId: "test/unavailable",
      read: () =>
        Effect.fail(
          new Vault.VaultUnavailable({ reason: "Unreachable", vault: A.id })
        ),
    });
  const needsClient = Task.make(spec, () => Client).provide(
    Layer.effect(Client, Effect.as(A.get("token"), "ready"))
  );
  const exit = await Effect.runPromiseExit(
    run(needsClient).pipe(Effect.provide(Vault.layer(A, unavailable)))
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(exit.cause.reasons[0]?._tag).toBe("Fail");
  }
  let finalized = false;
  const clientLayer = Layer.effect(
    Client,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        A.get("token").pipe(
          Effect.andThen(
            Effect.sync(() => {
              finalized = true;
            })
          ),
          Effect.orDie
        )
      );
      return "ready";
    })
  );
  await Effect.runPromise(
    run(Task.make(spec, () => Client).provide(clientLayer)).pipe(
      Effect.provide(provider)
    )
  );
  expect(finalized).toBe(true);
});

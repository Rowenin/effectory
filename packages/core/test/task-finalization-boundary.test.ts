import { expect, test } from "bun:test";

import { Cause, Context, Effect, Exit, Layer, Redacted, Schema } from "effect";

import { TaskRuntimeError } from "../src/errors.ts";
import * as Task from "../src/task.ts";
import * as Vault from "../src/vault.ts";

const canary = "CANARY-task-finalization-boundary";
const credentials = Vault.make({
  id: "finalization",
  secrets: { token: Schema.String },
});
const Client = Context.Service<boolean>("test/FinalizationClient");
const provider = Vault.layer(credentials, Vault.memory({ token: canary }));
const spec = {
  error: Schema.TaggedStruct("Transient", { message: Schema.String }),
  id: "finalization",
  input: Schema.Null,
  replay: "idempotent",
  success: Schema.String,
  version: 1,
} as const;
const read = credentials.get("token").pipe(Effect.orDie);

function expectRefused(exit: Exit.Exit<unknown, unknown>, defect: boolean) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    if (defect) {
      // Since Effect 4.0.6 a cleanup defect makes the declared failure fatal;
      // see docs/task-cleanup-cause-evidence.md.
      expect(Cause.hasFails(exit.cause)).toBe(false);
    } else {
      expect(Cause.findErrorOption(exit.cause)).toMatchObject({
        value: { code: "SecretInOutput" },
      });
    }
    expect(Cause.hasDies(exit.cause)).toBe(defect);
    expect(Cause.pretty(exit.cause)).not.toContain(canary);
  }
}

for (const defect of [false, true]) {
  test(`Layer acquisition errors receive secret validation, cleanup defect=${defect}`, async () => {
    let entered = false;
    const client = Layer.effect(
      Client,
      Effect.gen(function* () {
        const secret = Redacted.value(yield* read);
        yield* Effect.acquireRelease(Effect.void, () =>
          defect ? Effect.die(new Error(secret)) : Effect.void
        );
        return yield* Effect.fail({
          _tag: "Transient",
          message: secret,
        } as const);
      })
    );
    const task = Task.make(spec, () =>
      Effect.sync(() => {
        entered = true;
        return "unreachable";
      })
    )
      .provide(client)
      .provide(provider);
    expectRefused(
      await Effect.runPromiseExit(Task.test(task, { input: null })),
      defect
    );
    expect(entered).toBe(false);
  });
}

for (const result of ["success", "failure"] as const) {
  test(`a secret first read during Layer release protects the task ${result}`, async () => {
    let released = false;
    const client = Layer.effect(
      Client,
      Effect.acquireRelease(Effect.succeed(true), () =>
        read.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              released = true;
            })
          )
        )
      )
    );
    const task = Task.make(spec, () =>
      result === "success"
        ? Effect.succeed(canary)
        : Effect.fail({ _tag: "Transient", message: canary } as const)
    )
      .provide(client)
      .provide(provider);
    expectRefused(
      await Effect.runPromiseExit(Task.test(task, { input: null })),
      false
    );
    expect(released).toBe(true);
  });
}

test("runtime error messages from Layer acquisition are scrubbed like production", async () => {
  const task = Task.make(spec, () => Effect.succeed("unreachable"))
    .provide(
      Layer.effect(
        Client,
        Effect.gen(function* () {
          const secret = Redacted.value(yield* read);
          return yield* new TaskRuntimeError({
            code: "Unavailable",
            message: secret,
          });
        })
      )
    )
    .provide(provider);
  const exit = await Effect.runPromiseExit(Task.test(task, { input: null }));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.findErrorOption(exit.cause)).toMatchObject({
      value: { code: "Unavailable", message: "[vault secret omitted]" },
    });
    expect(Cause.pretty(exit.cause)).not.toContain(canary);
  }
});

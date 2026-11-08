import { expect, test } from "bun:test";

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

import * as Task from "../src/task.ts";
import * as Vault from "../src/vault.ts";

const Transient = Schema.TaggedStruct("Transient", {});
const spec = {
  error: Transient,
  id: "cleanup",
  input: Schema.Null,
  replay: "idempotent",
  success: Schema.String,
  version: 1,
} as const;
const Service = Context.Service<boolean>("test/Cleanup");
const failure = Effect.fail({ _tag: "Transient" } as const);
const cleanup = Effect.die("cleanup failed");
const resource = Effect.acquireRelease(Effect.succeed(true), () => cleanup);

for (const [name, task] of [
  ["handler", Task.make(spec, () => failure.pipe(Effect.ensuring(cleanup)))],
  [
    "Layer acquisition",
    Task.make(spec, () => Effect.succeed("unreachable")).provide(
      Layer.effect(Service, resource.pipe(Effect.andThen(failure)))
    ),
  ],
  [
    "Layer release",
    Task.make(spec, () => failure).provide(Layer.effect(Service, resource)),
  ],
] as const) {
  // Effect 4.0.6+ gives defects precedence: a dying cleanup turns the declared
  // failure into a defect too, so nothing typed remains to authorize a retry.
  test(`a cleanup defect from ${name} makes the declared failure fatal`, async () => {
    const exit = await Effect.runPromiseExit(Task.test(task, { input: null }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(Option.isNone(Cause.findErrorOption(exit.cause))).toBe(true);
      const defects = exit.cause.reasons.flatMap((reason) =>
        Cause.isDieReason(reason) ? [reason.defect] : []
      );
      expect(defects).toContainEqual({ _tag: "Transient" });
      expect(Cause.pretty(exit.cause)).toContain("cleanup failed");
    }
  });
}

test("mixed causes scrub secrets from the declared error and cleanup defect", async () => {
  const canary = "CANARY-mixed-cleanup-secret";
  const credentials = Vault.make({
    id: "cleanup",
    secrets: { token: Schema.String },
  });
  const task = Task.make(
    {
      ...spec,
      error: Schema.TaggedStruct("Transient", { message: Schema.String }),
    },
    () =>
      Effect.gen(function* () {
        const secret = Redacted.value(
          yield* credentials.get("token").pipe(Effect.orDie)
        );
        return yield* Effect.fail({
          _tag: "Transient",
          message: secret,
        } as const).pipe(Effect.ensuring(Effect.die(new Error(secret))));
      })
  ).provide(Vault.layer(credentials, Vault.memory({ token: canary })));
  const exit = await Effect.runPromiseExit(Task.test(task, { input: null }));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    // The secret-bearing declared error is now a defect; it is scrubbed too.
    expect(Cause.hasFails(exit.cause)).toBe(false);
    expect(Cause.pretty(exit.cause)).not.toContain(canary);
    for (const reason of exit.cause.reasons) {
      if (Cause.isDieReason(reason)) {
        const defect: unknown = reason.defect;
        expect(
          defect instanceof Error ? defect.message : JSON.stringify(defect)
        ).not.toContain(canary);
      }
    }
  }
});

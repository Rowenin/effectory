/* oxlint-disable unicorn/throw-new-error -- Effect Schema error class factory. */
import {
  Application,
  Artifact,
  ArtifactStorage,
  Task,
  TaskRuntimeError,
  Vault,
} from "@offtree/effectory-sdk";
import { Effect, Layer, Redacted, Schema } from "effect";

export const Infrastructure = Vault.make({
  id: "infrastructure",
  secrets: { "database-password": Schema.NonEmptyString },
});
export const Integrations = Vault.make({
  id: "integrations",
  secrets: { "github-token": Schema.NonEmptyString },
});
const report = Artifact.make({
  id: "vault/report",
  schema: Schema.String,
  version: 1,
});
class Failure extends Schema.TaggedError<
  Failure,
  { readonly brand: unique symbol }
>()("Failure", {
  message: Schema.String,
}) {}
const Read = Task.make(
  {
    error: Schema.Union([Vault.Errors, Failure]),
    id: "vault/read",
    input: Schema.String,
    outputs: { report },
    replay: "idempotent",
    success: Schema.String,
    version: 1,
  },
  (mode, context) =>
    Effect.gen(function* () {
      const database = Redacted.value(
        yield* Infrastructure.get("database-password")
      );
      const github = Redacted.value(yield* Integrations.get("github-token"));
      yield* Effect.logInfo(`Database password: ${database}`);
      yield* Effect.logError(new Error(`GitHub token: ${github}`));
      yield* context.progress({ message: `Authenticating ${database}` });
      if (mode === "result") {
        return database;
      }
      if (mode === "error") {
        return yield* new Failure({ message: github });
      }
      if (mode === "host") {
        return yield* new TaskRuntimeError({
          code: "InvalidBoundary",
          message: database,
        });
      }
      if (mode === "defect") {
        return yield* Effect.die(new Error(github));
      }
      if (mode === "artifact") {
        yield* (yield* ArtifactStorage).publish(report, database, {
          key: "report",
        });
      }
      if (mode === "metadata") {
        yield* (yield* ArtifactStorage).publish(report, "safe", {
          key: "report",
          tags: { token: database },
        });
      }
      return "Read both providers";
    })
);
export default Application.make({
  tasks: [Read],
  vaults: [Infrastructure, Integrations],
}).provide(
  Layer.mergeAll(
    Vault.layer(Infrastructure, Vault.local),
    Vault.layer(
      Integrations,
      Vault.memory({ "github-token": "example-fixture-github-token" })
    )
  )
) satisfies Application.Application<Vault.LocalStore>;

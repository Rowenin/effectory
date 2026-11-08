# Vault dependencies and post-run reports

This complete example checks that a declared credential exists and decodes correctly. It does not contact a remote service or prove authentication. Its report summarizes the recorded source outcome; it does not rerun the credential check.

Create `effectory.ts`:

```ts
import { Application, Report, Task, Vault } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

export const Credentials = Vault.make({
  id: "credentials",
  secrets: { "api-token": Schema.NonEmptyString },
});
export const CheckCredentials = Task.make(
  {
    id: "credentials/check",
    version: 1,
    input: Schema.Null,
    success: Schema.Struct({ present: Schema.Boolean }),
    error: Vault.Errors,
    replay: "idempotent",
  },
  () =>
    Effect.gen(function* () {
      // This checks existence and decoding, not whether a remote service accepts it.
      // Keep the Redacted wrapper; no raw value is needed for this operation.
      yield* Credentials.get("api-token");
      return { present: true };
    })
);
export const Summary = Task.make(
  {
    id: "credentials/summary",
    version: 1,
    input: Report.sourceOf(CheckCredentials),
    success: Report.result(
      Schema.Struct({
        status: Report.Status,
        credentialsPresent: Schema.NullOr(Schema.Boolean),
      })
    ),
    error: Schema.Never,
    replay: "idempotent",
  },
  (source) =>
    Effect.gen(function* () {
      const history = yield* Report.History;
      const outcome = yield* history.outcome(CheckCredentials);
      return {
        data: {
          status: source.status,
          credentialsPresent:
            outcome._tag === "Succeeded" ? outcome.value.present : null,
        },
        markdown: `# Credential check\n\nSource status: ${source.status}\n`,
      };
    })
);
export const CredentialReport = Report.make({
  id: "credential-summary",
  scope: "run",
  target: CheckCredentials,
  task: Summary,
});
export default Application.make({
  tasks: [CheckCredentials, Summary],
  reports: [CredentialReport],
  vaults: [Credentials],
}).provide(
  Vault.layer(Credentials, Vault.local)
) satisfies Application.Application<Vault.LocalStore>;
```

`Credentials` is its own Effect service. The application selects the provider with `Vault.layer(Credentials, Vault.local)`; the host supplies the local store, which is why the application requirement is `Vault.LocalStore` rather than `never`. Reads stay inside the task so each actual attempt reads the provider again. Do not read secrets while constructing application-level Layers. A completed durable task reuses its recorded result and does not refresh the secret on replay.

Register vaults in `Application.make` when the operator must manage them. The provider Layer and the typed declaration are separate: another supported backend can replace `Vault.local` without changing task reads. Distinct vault definitions can use different providers. Check extension coverage and authentication before selecting a third-party adapter; use Alchemy Distilled where it supplies the required operation.

`Vault.Errors` is declared explicitly. Missing, invalid, transient and permanent errors have different tags; do not turn every vault error into an automatic retry. This example has no retry policy. Keep values wrapped in `Redacted` until a client operation actually requires the raw value; never return the credential as the task result.

The reporter is an ordinary task with `Report.sourceOf` input and `Report.result` success. `Report.make` attaches it; both tasks must be registered. `scope: "run"` reports on this task when submitted directly, not every use inside another workflow. Use the existing invocation scope when that is intended. Reports have separate runs and can fail independently. A successful source command is not proof that its report finished.

Create `effectory.test.ts`:

```ts
import { expect, test } from "bun:test";

import { Report, Task, Vault } from "@offtree/effectory-sdk";
import { Cause, Effect, Exit, Option, Redacted, Schema } from "effect";

import { CheckCredentials, Credentials, Summary } from "./effectory.ts";

const canary = "CANARY-example-only-12345678";
const memory = Vault.layer(Credentials, Vault.memory({ "api-token": canary }));
const source = {
  invocationId: null,
  revision: "test-revision",
  runId: "source-run",
  scope: "run",
  status: "Succeeded",
  targetId: "credentials/check",
  targetKind: "task",
  targetVersion: 1,
} as const;

test("a task uses an injected memory vault without opening the local store", async () => {
  const result = await Effect.runPromise(
    Task.test(CheckCredentials.provide(memory), { input: null })
  );
  expect(result.value).toEqual({ present: true });
  expect(JSON.stringify(result.value)).not.toContain(canary);
  const absent = CheckCredentials.provide(
    Vault.layer(Credentials, Vault.memory({}))
  );
  const missing = await Effect.runPromise(
    Task.test(absent, { input: null }).pipe(Effect.flip)
  );
  expect(missing._tag).toBe("VaultSecretNotFound");
});

test("Report.test supplies typed source outcomes without rerunning the source task", async () => {
  const success = await Effect.runPromise(
    Report.test(Summary, {
      source,
      outcome: { _tag: "Succeeded", value: { present: true } },
    })
  );
  expect(success.value.data).toEqual({
    status: "Succeeded",
    credentialsPresent: true,
  });
  const cancelled = await Effect.runPromise(
    Report.test(Summary, {
      source: { ...source, status: "Cancelled" },
      outcome: { _tag: "Stopped", status: "Cancelled", detail: null },
    })
  );
  expect(cancelled.value.data).toEqual({
    status: "Cancelled",
    credentialsPresent: null,
  });
});

test("accidentally returning the raw secret is rejected", async () => {
  const Leaks = Task.make(
    {
      id: "test/leaks",
      version: 1,
      input: Schema.Null,
      success: Schema.String,
      error: Vault.Errors,
      replay: "idempotent",
    },
    () => Effect.map(Credentials.get("api-token"), Redacted.value)
  ).provide(memory);
  const exit = await Effect.runPromiseExit(Task.test(Leaks, { input: null }));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const text = Cause.pretty(exit.cause);
    expect(
      Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    ).toMatchObject({
      _tag: "TaskRuntimeError",
      code: "SecretInOutput",
    });
    expect(text).not.toContain(canary);
  }
});
```

The memory provider uses only a synthetic canary. It replaces local storage for these tests; no vault initialization, key file or real credential is needed. `Report.test` supplies the source outcome and History service, while `Task.test` by itself does not provide report history. Inspect tagged errors and fields such as `code`; formatted Cause text is diagnostic output, not a stable machine-readable error contract.

The accidental-disclosure guard covers matching values read within the attempt, including JSON results and publication metadata. It is not a sandbox: transformed values, short values, binary content and direct process/file/network output are outside its guarantees. Do not rely on redaction as permission to log credentials. Never put actual secrets in fixture code.

For a real local-vault project, start the daemon, inspect `vault describe credentials`, initialize the vault if necessary, and put `api-token` using a regular file or pipe and the current version token from describe. Keep plaintext inputs and key escrow outside the repository. Use CLI help for the existing input flags; do not guess a version token or place a secret in an argument. The example tests do not exercise these storage operations.

After a real source run, use its recorded run ID:

```sh
effectory report list <source-run-id>
effectory report wait <source-run-id>
effectory report get <report-id>
```

The exact application and tests were strictly typechecked against the workspace SDK and tested with its installed Effect library: three tests, eight assertions. Those in-memory tests do not prove automatic report admission, persisted secret sanitation, provider rotation or restart behavior.

A separate real CLI/daemon probe then initialized the local vault in a disposable repository and put a synthetic value from a regular file outside that repository, using the absence token returned by describe. The key directory was also outside the repository. The source task succeeded, its attached report ran automatically, and the report returned `Succeeded` with `credentialsPresent: true`. After graceful stop/start, the same put and submission keys replayed their original receipts/run; retained report content stayed unchanged; a new task read the local value successfully and produced another report. Both daemons exited cleanly. A scan of the stopped repository's 12 files found no synthetic plaintext. The temporary repository, input file and keys were removed afterward.

This verifies the example's local-provider and report path, not an external credential, remote provider, rotation, interrupted report recovery, arbitrary secret-leak prevention or authenticated agent discovery. Only synthetic test data was used.

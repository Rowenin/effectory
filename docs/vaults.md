# Vaults

Vaults are typed Effect services. A definition declares the logical secret names and their string codecs; a Layer selects the backing provider. The host supplies local storage, and extensions can supply read providers. There is no implicit environment-variable fallback and no new task context capability.

## Define, read and provide

```ts
import { Application, Task, Vault } from "@offtree/effectory-sdk";
import { Effect, Layer, Redacted, Schema } from "effect";

const Infrastructure = Vault.make({
  id: "infrastructure",
  secrets: { "database-password": Schema.NonEmptyString },
});
const Integrations = Vault.make({
  id: "integrations",
  secrets: { "github-token": Schema.NonEmptyString },
});
const Check = Task.make(
  {
    id: "check",
    version: 1,
    replay: "idempotent",
    input: Schema.Null,
    success: Schema.Boolean,
    error: Vault.Errors,
  },
  () =>
    Effect.gen(function* () {
      const password = yield* Infrastructure.get("database-password");
      const token = yield* Integrations.get("github-token");
      // Unwrap only at the client boundary that needs the credential.
      return (
        Redacted.value(password).length > 0 && Redacted.value(token).length > 0
      );
    })
);

export default Application.make({
  tasks: [Check],
  vaults: [Infrastructure, Integrations],
}).provide(
  Layer.mergeAll(
    Vault.layer(Infrastructure, Vault.local),
    // A fixture provider. Replace this Layer with an installed remote provider.
    Vault.layer(Integrations, Vault.memory({ "github-token": "test-token" }))
  )
) satisfies Application.Application<Vault.LocalStore>;
```

`yield* Infrastructure` returns the handle, so `(yield* Infrastructure).get(key)` also works. `getOption(key)` returns `Option<Redacted<A>>`; it returns None only for an absent value, not an unavailable provider or invalid value. `FiniteFromString` and `fromJsonString` codecs support decoded values other than strings. Both reads and administrative puts decode asynchronously with a five-second cooperative timeout. Blocking JavaScript and uninterruptible finalizers cannot be preempted.

Use one canonical definition imported from a contracts module. Different calls to `Vault.make`, even with identical IDs, are different services. Duplicate registered IDs fail application construction. Registration also checks the provider and enables CLI administration. An unregistered service can serve tasks, but a missing provider is detected at read time.

A task declares `Vault.Errors`, combines it with domain errors, or handles failures itself. `VaultUnavailable` is suitable for configured retries; `VaultFailure` covers permanent failures such as wrong keys, corruption and closed resources. Codecs report `VaultSecretInvalid` without including their input or Schema issue. Providers return typed, value-free errors too.

Task tests use ordinary Layers:

```ts
Task.test(Check, { input: null }).pipe(
  Effect.provide(
    Layer.mergeAll(
      Vault.layer(
        Infrastructure,
        Vault.memory({ "database-password": "test-password" })
      ),
      Vault.layer(Integrations, Vault.memory({ "github-token": "test-token" }))
    )
  )
);
```

## Provider extensions

A factory returns `Vault.Implementation<E, R>`, an Effect that acquires a backend in a Scope. The required backend operation is:

```ts
read(key: string): Effect.Effect<
  Option.Option<Redacted.Redacted<string>>,
  Vault.VaultUnavailable | Vault.VaultFailure
>
```

`providerId` identifies the provider; optional `inspect(key)` and `list` return metadata without reading secret values. List results are bounded to 256 names. `Vault.layer` wraps the backend with schema decoding, invocation ownership and protection. Clients and authentication dependencies use ordinary Effect services and Layers.

Factories can be published through the existing extension contracts exports and installed with:

```sh
effectory extension add github:OWNER/REPOSITORY@TAG --as Secrets --trust
```

The extension chooses its factory name and options. The application can supply `Secrets.exports.provider(options)` as the second argument to `Vault.layer`, then restart the daemon to activate the source edit. The factory should defer provider/client imports until its Layer is acquired; all emitted lazy chunks belong in the archive manifest. Select `Extension.use(Secrets)` when the application needs the extension's contributions and provenance.

Provider-specific configuration maps logical keys to AWS secret identifiers, 1Password references or other remote locations. Each vault chooses one provider; a different vault can choose another. No first-party AWS, Azure or 1Password adapter ships in this slice. Installed read-provider factories are covered by a synthetic archive, fake-gh installation, generated declaration, real daemon restart and cleanup test.

Remote and memory providers are read-only to administration. They can expose raw values through explicit `vault reveal`; `init`, `put` and `delete` are local-provider operations. There is no generic remote write/version contract yet.

## Lifetimes and protection

Application providers belong to the retained revision's Scope. Task-local Layers rebuild per attempt and close before the attempt finishes. Reads during host application construction are rejected: acquire credentials in task-local Layers or when a client is called by a task. Capturing a handle or context in an application Layer is supported. Completed durable tasks reuse their recorded result without reading credentials again.

A provider whose acquisition depends on missing bootstrap configuration can still stop revision loading. Startup loads the active revision; inactive retained revisions acquire providers when execution or an administrative operation borrows them. The provider stays alive through the operation and closes after the last borrower releases it. Keep bootstrap configuration available for historical revisions that must still execute, or defer its use to reads. Retained bundles are not pruned. A local provider's construction does not open the database or require an initialized key; failures occur on operations, leaving the daemon available for diagnosis.

Values read during an attempt are tracked until final durable result/error encoding. Matching log/progress fields are omitted; JSON task results, domain errors, artifact values, publication keys and tags containing a tracked value are rejected. Defects and host-failure messages are scrubbed. Task-local finalizers remain protected. Late output after tracking clears gets an omission marker. Provider-internal Effect logs are suppressed before values can be registered.

This is an accidental-disclosure guard, not a sandbox. It does not cover binary contents, direct console/file/process/network I/O, arbitrary transformations, or strings shorter than eight UTF-8 bytes. Standalone reads without host ownership are unmanaged. Host-owned handles refuse fresh untracked root fibers. Raw JSON secret strings also register their string leaves, so public-looking fields such as a region can cause false positives. Keep ordinary configuration out of secret objects.

The tracker permits 256 distinct raw/escaped strings and 1 MiB of tracked text per invocation, with bounded JSON traversal. `Task.test` covers its own encoding, progress and publications; daemon tests cover persisted telemetry and the interpreter's final encoding.

## CLI and recovery

After starting the daemon with a registered local vault:

```sh
effectory vault list
effectory vault describe infrastructure
effectory vault init infrastructure
# Read the current key token from describe. 0 is only the fresh-store token.
effectory vault put infrastructure database-password --file ~/tmp/password.txt --if-version 0
effectory vault reveal infrastructure database-password
effectory vault delete infrastructure database-password --if-version 1
```

Put accepts a regular file or pipe (`--file -`); terminal input is refused. Exact valid UTF-8 is preserved, including trailing newlines, with a notice when a line break is present. Values never appear in command arguments. Reveal writes raw bytes without an added newline and refuses `--json`; optional `--output` creates a new 0600 file, refuses overwrite, and must point outside the repository. Shell redirection cannot be inspected by the CLI.

Online commands accept `--revision` for a retained provider. During provider changes, use the earlier revision for retries or cleanup. Puts and deletes require `--if-version`; optional `--request-key` identifies a retry. An exact retry returns the original receipt and the current key state. A reused request key with a different payload fails Conflict. Receipts retain the newest eight per key, up to 4096 per store; after eviction a stale write still cannot overwrite a newer value.

Local versions are opaque strings. Reset or tombstone pruning advances a global absence token, so a previously prepared create in another vault can safely conflict; describe again and retry. Existing present keys keep their tokens. Restoring an older database restores older tokens too: describe again before writes after restore.

Each local vault has an external root key, named by its random key ID. Directory precedence is `EFFECTORY_KEY_DIR`, `$XDG_CONFIG_HOME/effectory/keys`, then `~/.config/effectory/keys`. Key directories inside the repository are refused. Missing or wrong keys are never silently replaced.

```sh
effectory daemon stop
# Prepare an external escrow directory first.
effectory vault key export infrastructure --output ~/escrow/infrastructure.key
effectory backup ../snapshot
# After restoring on another machine:
effectory vault key import infrastructure --file ~/escrow/infrastructure.key
```

Key operations require exclusive repository ownership and run offline. Exported key files are raw recovery credentials. Backup copies the repository tree; keys are excluded only because they live elsewhere. Keep plaintext input files outside the repository and remove them after use. Older backups may still need older key files, which are never automatically deleted.

`vault reset <vault> --discard` is offline and destructive: it deletes that vault's ciphertext, receipts and metadata, advances the absence token, and leaves other vaults and external key files intact. It also works for removed definitions and lost keys. For file-level database corruption, restore `.effectory/vaults.sqlite` with its necessary WAL from backup; moving the database and its WAL/SHM files aside loses every local vault in that store. Doctor reports unavailable vault storage and keys.

Limits are 64 KiB per value, 16 MiB live ciphertext, 128 stored local vaults, 256 stored keys per vault and a 64 MiB database page cap. Old tombstones and receipts can be pruned; live values are never automatically removed. Delete/reset can reclaim capacity, though a physically full filesystem may require freeing external space first. The WAL has its own checkpoint lifecycle. These bounds do not remove the existing 1 GiB total backup limit or bound unrelated run history. Deletion is not secure erasure of old pages or backups.

RPC methods are `VaultList`, `VaultDescribe`, `VaultInit`, `VaultPut`, `VaultDelete` and `VaultReveal`, advertised by `vault.v1`. Keys and destructive reset remain offline, outside RPC. The [approved proposal](vault-api-draft.md) records detailed error mappings and review decisions.

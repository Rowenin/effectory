# Vaults — Effect design review, round 1

Reviewer: Claude (Effect perspective). Input: `docs/vault-research.md`. This is a design pass that picks a single consumer contract for the parent to draft. It approves nothing, the user has not approved it, and it authorizes no implementation. A consumer review and a second Effect review of the parent draft are still required before anything is presented.

**Readiness: ready for a parent draft**, provided the draft carries forward the six user decisions in §14 and the four assumptions to verify in §15. It is **not** ready for implementation approval.

Labels: **[fact]** means read in source or observed in a scratch probe. **[probe]** means type-checked or run against pinned Effect 4.0.5 and the real SDK, using a stand-in for the proposed Vault module. **[inference]** means reasoned from source but not run. **[assumption]** means it must be checked before implementation approval.

---

## 1. Recommendation in one screen

- **A vault is a nominal `Context.Service` key, and its spec holds no provider.** `Vault.make({ id })` returns a key for the `Vault<Id>` service. It also carries an accessor, `Credentials.get(key)`, of type `Effect<Redacted<string>, Vault.ReadError, Vault<Id>>`.
- **A provider is an ordinary `Layer<Vault<Id>, E, R>`.** It is selected with `Application.provide`, overridden with `Task.provide`, and faked with `Vault.memory(...)`. There is no provider registry, no second argument to `Vault.make`, and no new task-context field.
- **Registration is for administration only.** `Application.make({ vaults: [Credentials] })` lets the daemon find the provider for CLI `list`/`put`/`delete`/`read`. Tasks already declare their need through `R`.
- **Errors are three Schema tagged errors with no value fields:** `VaultSecretNotFound`, `VaultUnavailable` and `VaultFailure`. They fit the existing error schema and retry machinery unchanged.
- **Managed protection rejects values instead of scrubbing them.**
  - Values read through the accessor during an invocation are registered in an invocation-local set.
  - Typed boundaries (success, domain error, JSON artifacts) **fail** with `TaskRuntimeError("SecretInOutput")` if a registered value appears in them.
  - Untyped text (logs, progress, defect messages) is **replaced whole** with a placeholder.
  - Binary artifacts, stdout, child processes and HTTP are explicitly **not** covered.
- **Local provider:** AES-256-GCM, with one file per secret under `.effectory/vaults/<id>/`. The random key lives **outside the repository** and is created only by an explicit `vault init`. Missing key material is never silently regenerated. Backup carries ciphertext but not the key.
- **The CLI goes through the daemon RPC only.** Values arrive from stdin or a file and are never passed as a `--value` argument. Nothing is recorded in a receipt, and no value hash is persisted.

---

## 2. Source facts the design depends on

| # | Fact | Where |
| --- | --- | --- |
| F1 | Application capture: `Application.make` takes the whole application Context once (`Effect.context<Requirements…>()`) and wraps every task's `execute` with `provideContext(services)`. Application-provided services therefore surround the task's own Layers, retries and finalizers. | `packages/core/src/application.ts:103,121` |
| F2 | The revision loader reads only `Registry` from the built Context. Services provided to an application are captured in closures and cannot be reached afterwards. Daemon-side administration therefore needs an explicit registry entry. | `packages/platform-bun/src/revisions.ts:82–88` |
| F3 | Each invocation gets a fresh `MemoMap` and its own `ArtifactStorage`/`Tag.Values` through `provideContext`. `Task.provide` builds task-local Layers into that memo map and that scope, and removes `ROut` from `R`. | `packages/core/src/task.ts:386–408` |
| F4 | Every retained revision, up to 128, builds its application Layer at daemon start, not only the active one. | `docs/runtime-ownership-audit.md` (lines 45–51) |
| F5 | Each retry attempt calls `task.execute` again. A durable replay of a completed Activity does not re-run the handler. | `interpreter.ts:200–345`; audit line 33 |
| F6 | Task logs pass through `taskLogger.message()`. Non-JSON values are replaced with an "omitted" string. `Error` values are stored as `{name, message}`. | `packages/platform-bun/src/task-logger.ts` |
| F7 | Activity exits are persisted with `Schema.Exit(…, Schema.Defect())`, so a defect's `name`/`message` is durable. | `node_modules/effect/dist/workflow/Activity.js:46` |
| F8 | Retry selects on the **top-level** `_tag` of a decoded domain error only. | `interpreter.ts` (`retry.when.includes(tag)`) |
| F9 | Extension contract modules are a separate ESM entry from implementations and "must not import handlers or acquire resources". Consumers reach extra contract exports through `.exports`. | `extension-archive.ts:161–176`; `docs/extension-task-consumption.md:72,98` |
| F10 | Backup excludes only `node_modules`, `.git`, `daemon.json*`, `daemon.log` and SQLite owner/shm files. A key file under `.effectory/` would be copied. | `backup.ts:53–66` |
| F11 | The daemon RPC is loopback HTTP with a bearer token and a repository-id header. `repositoryId` is generated alongside `daemon.json`, which backup excludes, so it is not a stable identity for keys. | `daemon.ts:37–70,254` |
| F12 | Wait and cancellation receipts persist a `fingerprint` and `receiptJson`. No vault RPC should reuse this pattern for values. | `host-store.ts:208–215` |
| F13 | `Logger.Options` exposes `fiber`, so a logger can read a fiber `Context.Reference`. | `effect/dist/Logger.d.ts:81–87` |

---

## 3. Probe results (pinned Effect 4.0.5, real SDK, stand-in `Vault` module)

The scratch files are in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/afed959f-b7f3-444a-8aa5-b54170c06d06/scratchpad/vault-probe/` (`vault.ts`, `consumer.ts`, `runtime.ts`, `echo.ts`, `echo2.ts`). They use only the synthetic value `CANARY-synthetic-0000`. Production source was not changed.

**Type probes (`tsc` with the repo's tsconfig, no errors; every `@ts-expect-error` fired):**

| Check | Result |
| --- | --- |
| `Task.make(spec, () => Credentials.get("github-token")…)` infers `R` = exactly `Vault<"credentials">` | ✔ |
| Providing `Vault.memory(Other, …)` leaves `Vault<"credentials">` unmet, so `satisfies Application<never>` fails | ✔ (nominal per id) |
| `Application.make(...).provide(Vault.memory(Credentials, {}))` satisfies `Application<never>` | ✔ |
| `Deploy.provide(Vault.memory(Credentials, …))` has `R = never` | ✔ |
| A task with `error: Schema.Never` that calls `get` without handling errors is rejected | ✔ (deliberate; see §6) |
| The same task with `Effect.orDie` compiles | ✔ |
| `Credentials.get("db", Schema.fromJsonString(Struct))` has type `Redacted<{user, pass}>` | ✔ |
| A provider Layer needing another service plus `Config.Redacted(...)` surfaces both: the service in `R`, `ConfigError` in `E` | ✔ |

A function-style `Context.Service<Shape>(key)` would use the provider shape as its identifier type. Every vault would then share one requirement, and providing any vault would type-check for all of them. The `Vault<Id>` brand avoids that (see `vault.ts`).

**Runtime probes:**

| Path | Result |
| --- | --- |
| `Task.test(Deploy.provide(Vault.memory(...)))` | succeeds |
| Missing key → task failure encoded with `Vault.Errors` | `{"_tag":"VaultSecretNotFound","vault":"credentials","key":"github-token"}`, with no value |
| `Effect.log(redacted)` through the real `taskLogger` | clean (the value is "omitted": a Redacted is not JSON) |
| ``Effect.log(`token=${redacted}`)`` | clean (`<redacted>`) |
| `Effect.log({ token: redacted })` | clean (omitted) |
| ``Effect.log(`raw=${Redacted.value(r)}`)`` | **LEAKS** |
| `logError` with a Cause whose `Error.message` holds the unwrapped value | **LEAKS** (stored as `error.message`) |
| `Schema.encode(Schema.Defect())` of the same Error, i.e. the durable Activity exit | **LEAKS** |
| Success value `` `echo ${Redacted.value(t)}` `` through `Task.test` | **LEAKS** (the typed boundary accepts it) |
| `success: Schema.Redacted(Schema.String)` returning the Redacted | rejected: `InvalidBoundary` |
| Default 4.0.5 Schema messages for minLength, literal, invalid JSON and field type, when decoding a canary | clean, with no echo |
| A custom `Schema.makeFilter` message that interpolates its input | **LEAKS** |
| Stand-in `Credentials.get(key, schema)` with the issue text replaced | clean: `VaultFailure{reason:"InvalidValue"}` |
| Two `Vault.make({id:"credentials"})` | same Context key `@offtree/effectory-sdk/Vault/credentials` and the same `Vault<"credentials">` type, so they behave consistently |

These results confirm that `Redacted` protects inspection, string coercion and JSON serialization of the _wrapper_. Once a value is unwrapped, nothing in Effect or Effectory protects it. This is the gap that §9 addresses.

---

## 4. The two candidate spellings

|  | **A. Definition is the key** — `Credentials.get(k)` | **B. One storage service** — `(yield* VaultStorage).get(Credentials, k)` |
| --- | --- | --- |
| Requirement | `Vault<"credentials">`, per vault and nominal | `VaultStorage`, the same for every vault |
| Missing provider | compile error (`Application<never>` fails) | runtime "vault not registered" error |
| Selection | `Layer` composition | requires a registry of `{definition → layer}` inside VaultStorage, which reinvents Context |
| Test override | `task.provide(Vault.memory(Credentials, …))` | replace all of VaultStorage, or add a merge API |
| Per-invocation host behavior (registration for §9) | through a `Context.Reference` read by the accessor | natural, since VaultStorage could be invocation-owned like ArtifactStorage |
| Precedent | ordinary `Context.Service` and `ReleaseClient` | `ArtifactStorage` (but that service is invocation-_owned_, and a provider is not) |

**Choose A.** B's only advantage is invocation ownership, and A gets the same effect with an internal `Context.Reference` (§9) without erasing which vault a task needs. B would rebuild Context lookup on top of Context.

**No implementation second argument on `Vault.make`.** Binding a provider into the spec would make the spec module import provider code. That breaks extension contract modules (F9) and forces test substitution to go through a replacement. Here the provider plays the "implementation" role and is a Layer. This is the same split as `Task.contract`/`Task.implementation`, but Layer already supplies it, so no extra abstraction is needed.

---

## 5. Proposed public surface (types)

```ts
// @offtree/effectory-sdk — namespace Vault
export interface Vault<Id extends string> { readonly [VaultId]: Id }   // nominal requirement

export interface Spec<Id extends string> {
  readonly id: Id;               // identifier(); namespaced for extensions ("acme/aws-prod")
  readonly description?: string;
}

export interface Provider {
  readonly providerId: string;   // shown in `vault list`; e.g. "effectory/local", "acme/aws-secrets"
  readonly get: (key: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, VaultUnavailable | VaultFailure>;
  readonly list?: Effect.Effect<ReadonlyArray<string>, VaultUnavailable | VaultFailure>;
  readonly put?: (key: string, value: Redacted.Redacted<string>) => Effect.Effect<void, VaultUnavailable | VaultFailure>;
  readonly remove?: (key: string) => Effect.Effect<boolean, VaultUnavailable | VaultFailure>;
}

export interface Definition<Id extends string> extends Context.Service<Vault<Id>, Provider> {
  readonly kind: "Vault";
  readonly id: Id;
  readonly spec: Spec<Id>;
  readonly get: {
    (key: string): Effect.Effect<Redacted.Redacted<string>, ReadError, Vault<Id>>;
    <A>(key: string, schema: Schema.Codec<A, string, never, never>):
      Effect.Effect<Redacted.Redacted<A>, ReadError, Vault<Id>>;
  };
}

export function make<const Id extends string>(spec: Spec<Id>): Definition<Id>;
export function memory<Id extends string>(vault: Definition<Id>, values: Readonly<Record<string, string>>): Layer.Layer<Vault<Id>>;
export function local<Id extends string>(vault: Definition<Id>): Layer.Layer<Vault<Id>, never, LocalStore>;

export class VaultSecretNotFound extends Schema.TaggedError<…>()("VaultSecretNotFound", { vault: Schema.String, key: Schema.String }) {}
export class VaultUnavailable  extends Schema.TaggedError<…>()("VaultUnavailable",  { vault: Schema.String, message: Schema.String }) {}
export class VaultFailure      extends Schema.TaggedError<…>()("VaultFailure", {
  vault: Schema.String, key: Schema.optionalKey(Schema.String),
  reason: Schema.Literals(["InvalidValue", "Unsupported", "Misconfigured", "LimitExceeded", "Closed"]),
  message: Schema.String,
}) {}
export type ReadError = VaultSecretNotFound | VaultUnavailable | VaultFailure;
export const Errors: Schema.Union<[typeof VaultSecretNotFound, typeof VaultUnavailable, typeof VaultFailure]>;

// Host-provided; see §8. Authors never construct it.
export class LocalStore extends Context.Service<LocalStore, …>()("@offtree/effectory-sdk/Vault/LocalStore") {}

// Application.make gains one optional field.
Application.make({ …, vaults?: readonly Vault.Definition<string>[] })
//   adds Vault<Id> for each listed vault to the Application requirement.
```

Design notes:

- **Secret keys are free strings**, validated by a key-name rule such as `identifier()`. Key names are _not_ secret. They appear in errors, logs and the CLI, as they do in Swamp.
- **`get(key, schema)`** exists because hand-written decoding of `Redacted.value(x)` is where custom Schema messages leak (§3). The accessor drops the issue and returns `VaultFailure{reason:"InvalidValue"}`. Decode-time services are excluded (`never`), matching `Boundary`.
- **The provider returns `Option`, and the accessor returns `NotFound`.** Absence is part of the provider protocol. The consumer gets a typed error, and can use `Effect.option`/`catchTag` when absence is expected.
- **Why `Provider` uses a `remove` method:** `delete` is fine as a property name, but `remove` avoids reserved-word friction in destructuring. This is cosmetic, and the parent may pick either.
- **No declared key catalog in the spec for v1.** Swamp keys are dynamic, and per-tenant keys are a real use case. This is a user decision (§14 D4).

---

## 6. Preferred end-to-end authoring shape

```ts
// vaults.ts — pure spec, safe to import anywhere (contracts, tests)
import { Vault } from "@offtree/effectory-sdk";
export const Credentials = Vault.make({
  id: "credentials",
  description: "Deploy credentials",
});

// deploy.ts
import { Task, Vault } from "@offtree/effectory-sdk";
import { Effect, Redacted, Schema } from "effect";

import { Credentials } from "./vaults.ts";

export const Deploy = Task.make(
  {
    id: "example/deploy",
    version: 1,
    replay: "idempotent",
    input: Schema.Struct({ repo: Schema.String }),
    success: Schema.Struct({ status: Schema.Number }),
    error: Vault.Errors, // or Schema.Union([Vault.Errors, MyErrors])
  },
  ({ repo }) =>
    Effect.gen(function* () {
      const token = yield* Credentials.get("github-token"); // Redacted<string>, fresh per attempt
      const status = yield* callApi(repo, token); // unwrap only inside the I/O call
      return { status };
    })
);
// retry on transient provider failure only (F8: top-level tag):
//   graph.task("deploy", Deploy, input, { retry: { attempts: 3, delay: "5 seconds", when: ["VaultUnavailable"] } })

// effectory.ts
export default Application.make({
  tasks: [Deploy],
  workflows: [Release],
  vaults: [Credentials],
}).provide(
  Vault.local(Credentials)
) satisfies Application.Application<Vault.LocalStore>;

// deploy.test.ts — fixture override, no daemon, no files
const result =
  yield *
  Task.test(
    Deploy.provide(Vault.memory(Credentials, { "github-token": "fixture" })),
    { input: { repo: "r" } }
  );

// Same task, extension-supplied provider (installed facade):
export default Application.make({
  tasks: [Deploy],
  vaults: [Credentials],
}).provide(
  AwsSecrets.exports.layer(Credentials, {
    region: "us-east-1",
    prefix: "prod/",
  })
);
// AwsSecrets.exports.layer : <Id>(v: Vault.Definition<Id>, o: Options) => Layer<Vault<Id>, ConfigError, never>
```

Operator:

```sh
effectory vault list                                  # vaults, providerId, capabilities; no values
effectory vault init credentials                      # local provider only: creates key + metadata
printf %s "$TOKEN" | effectory vault put credentials github-token      # stdin
effectory vault put credentials github-token --from-file ./token.txt
effectory vault keys credentials                      # key names
effectory vault delete credentials github-token
effectory vault read credentials github-token --reveal   # deliberate raw read to stdout
```

**Error ergonomics.** A `Schema.Never` task must write `.pipe(Effect.orDie)` or declare `Vault.Errors`. That is a deliberate one-line cost. The tagged errors carry only vault and key names, so `orDie`'s durable defect (F7) is safe for them. The parent draft should show both forms and recommend `Vault.Errors`, because durable typed failures and retry are only available with it. An alternative is to have `Task.make` accept vault errors implicitly as host failures. That would change `Task.make`'s error contract, so I recommend against it (§14 D2).

---

## 7. Registration and extension selection

- **Tasks need no registration.** `R` already carries `Vault<Id>`, and `Application<never>` will not type-check without a provider [probe].
- **`vaults: [...]` exists only so the host can administer.** At build time, `Application.make` reads `Context.get(services, def)` for each listed vault and stores `{definition, provider}` in `Registry.vaults` (F2). Duplicate ids, or two different definition objects with the same id, are a `DefinitionError`.
  - A vault that is provided but not listed still works for tasks. It is invisible to the CLI, and the parent should say so.
  - Listing a vault that no task reads is valid: the vault is administered only.
- **No `Extension.use` selection for providers.** A provider is chosen by whichever Layer the application provides, so there is no second selection mechanism to keep consistent with Layer composition.
  - Provenance is carried by `Provider.providerId` and shown by `vault list`.
- **Extensions can export three things:**
  1. A provider factory, e.g. `exports.layer(vault, options)`.
  2. Vault definitions that their own tasks require, e.g. `exports.Credentials`. Their tasks' `Vault<Id>` requirement flows through `Extension.Requirements` exactly as `ReleaseClient` does today [inference, same type path].
  3. Nothing else is needed.
- **The provider factory must defer implementation code.** A contract module must not import handler or client code (F9). The factory therefore wraps its implementation in `Layer.unwrap(Effect.tryPromise(() => import("./provider.mjs")).pipe(...))`.
  - **[assumption A1]** The extension archive and bundler preserve a contract-entry → implementation-entry dynamic import, and the validator accepts it.
  - If it does not, the minimal fallback is an `Extension.make({ layers: {...} })` contribution that `Installed.load()` yields. That would be a new extension contract and needs its own review.

---

## 8. Lifetimes

| Phase | What lives there | Behavior |
| --- | --- | --- |
| Revision Layer (F1, F4) | provider client, key material, connection pools | Built once per retained revision, up to 128, including at daemon start. A provider whose bootstrap `Config` is missing **fails that revision's load**, and the parent must state this. Providers should acquire long-lived clients here and **must not cache secret values** (see below). |
| Invocation | the read registry (§9) and `Redacted` values | Every attempt calls `execute` again (F5), so every `get` reads the backend again, and Effectory itself caches nothing. A durable replay of a completed activity does not re-read, which is correct and does not recompute. |
| Task-local Layer (`Task.provide`) | e.g. an HTTP client authorized with a token | Built inside the invocation (F3), so reads made during acquisition and finalization are registered and fresh per attempt. **This is the recommended place to build credentialed clients.** |
| Application-level Layer that reads a secret | e.g. `Layer.effect(Api, Credentials.get(...))` given via `Application.provide` | Allowed by the types. It reads **once per revision build**, is not refreshed on retry or rotation, and is **unmanaged** (no registry). The parent must document this. Recommendation: allow it and document it rather than fail it, because rejecting reads outside an invocation would also break standalone Effect tests (§14 D5). |
| A fiber that outlives the invocation | `get` after the invocation closes | Owned forks are interrupted by the publication lifetime (audit line 39). An accessor that finds a _closed_ registry fails with `VaultFailure{reason:"Closed"}`, which mirrors "Invocation closed". |
| Old runs and revisions | the pinned revision's provider instance | An old run reads through its pinned provider _code_ against _current_ backend values. The local provider instances of all revisions share the same files, so rotation is visible immediately. |

**Provider value caching.** Swamp's rule is no value caching. The `Provider` contract should state that "`get` reflects the backend at call time; any provider-side caching must be documented by that provider and bounded". Effectory cannot enforce this. The local and memory providers do not cache.

**`Vault.LocalStore` is the first host-provided application service.** The local provider needs the repository root and a key directory, and only the host knows either. The loader currently accepts `Layer<Registry, unknown>` with `R` erased (F2), so it must provide `LocalStore` when building revisions. The documented check also changes from `satisfies Application<never>` to `satisfies Application<Vault.LocalStore>`. This is ordinary DI, not a task context field. It is still a visible contract change and goes to the user (§14 D3).

---

## 9. Managed persistence and redaction

**Mechanism.**

1. An internal `Context.Reference` called `VaultReads` defaults to "unmanaged". `Task.definition.execute` provides a fresh one per invocation, next to `ArtifactStorage` (F3).
2. `Definition.get` registers each value it returns, then gives it to the caller.
3. Calling the provider directly through `yield* Credentials` and then `.get` bypasses registration. Document it as unmanaged.
4. Limits: 256 values per invocation and 64 KiB per value. A read beyond either limit fails with `VaultFailure{reason:"LimitExceeded"}` rather than silently going untracked.
5. Matching covers the exact UTF-8 plaintext and its JSON-string-escaped form. Values shorter than **8 bytes** are not matched, because a short value would cause spurious rejections; the parent must state this.

**What each boundary does:**

| Boundary | Action on a registered value | Why |
| --- | --- | --- |
| Task success (`Task.make` encode) | **fail** `TaskRuntimeError{code:"SecretInOutput"}`, a non-retryable host failure; the message names vault and key, never the value | Rewriting a typed result would break its schema, its digest and downstream decoding |
| Domain error encode | same failure | same |
| JSON artifact publish (`storageFor`/`contextFor`) | same failure, before `runtime.publish` | the digest and lake must never hold the value |
| Progress message | replace the whole message with `"[omitted: contained a value from vault credentials]"` | untyped text, and masking is honest |
| Task logs (`taskLogger`, which reads the Reference from `options.fiber`, F13) | replace the whole `message`/`error` field the same way | covers the two **LEAKS** rows in §3 |
| Defects in the activity body (F7) | the interpreter catches the defect and, if its text matches, replaces it with `hostFailure("Defect omitted: contained a vault value")` | covers the `Schema.Defect` **LEAKS** row |
| `Schema.Redacted` in task/artifact schemas | already rejected by the JSON boundary [fact] | keep |
| `Schema.RedactedFromValue`, `toCodecJson(Redacted)` | encode plaintext [research fact], and are then caught by the registry check | treated as unsafe; document it |
| Binary artifacts | **not scanned in v1** | streaming scan cost and false positives; state it as a limitation |
| stdout/stderr of the daemon, child processes, outbound HTTP, transformed values (base64, hashes, substrings) | **not covered** | the host neither sees nor owns these |

The promise therefore reads: _"Effectory rejects or omits verbatim vault values read through `Vault.get` during the current invocation at its managed persistence boundaries. It does not detect transformed, short or unregistered values, and it does not control I/O your code performs."_ It makes no claim of cross-invocation memory, of encryption at rest for run data, or of tamper resistance against task code, which is trusted.

**Durability rule for authors:** pass **key names** through graph edges, not values. A downstream task reads the key again. The parent should include this as an explicit anti-pattern, for example "never return a credential to feed a graph edge".

---

## 10. Local encrypted provider and CLI contract

**Layout.** All paths are inside the repository, so backup includes them.

```
.effectory/vaults/<vault-id>/vault.json       { format: 1, vaultId, keyId (random 128-bit, hex), createdAt }
.effectory/vaults/<vault-id>/s/<key>.enc      { format: 1, nonce (96-bit, b64), ciphertext+tag (b64) }
```

`<key>` is validated by the key-name rule. If that rule allows `/`, the file name is the hex form of the key name, so the provider never relies on filesystem escaping. Directories are `0700` and files `0600`.

**Key.** 256 random bits at `~/.config/effectory/vault-keys/<keyId>.key` (`$XDG_CONFIG_HOME` when set), mode `0600`, directory `0700`.

- The key is outside the repository, so backup does not copy it (F10).
- The path is keyed by `keyId`, not by `repositoryId`, because `repositoryId` does not survive a restore (F11).
- The key is random, so it is used directly and needs no PBKDF2. Swamp derives per-secret keys from SSH keys or passphrases; that is not needed here.
- An operator-supplied key source (`keyFile` path or an env var name) is a possible later option and is not in v1.

**Encryption.** AES-256-GCM through `crypto.subtle`, with a fresh random nonce on every write. The AAD is `effectory-vault/1\0<vaultId>\0<key>`, which binds each ciphertext to its slot: a ciphertext swapped between keys fails authentication.

**State rules.** The provider never generates a key outside `init`.

| State | Behavior |
| --- | --- |
| No `vault.json` | `get` → `NotFound`. `put` → `VaultFailure{Misconfigured}: run "effectory vault init <id>"`. |
| `vault.json` present, key file missing | every operation → `VaultFailure{Misconfigured, "key <keyId> not found; restore it with 'vault key import'"}` |
| GCM authentication fails | `VaultFailure{InvalidValue, "ciphertext failed authentication"}`, from either a wrong key or corruption; nothing is rewritten |
| `init` when a `vault.json` exists | refused |

**Crash points.** Every write goes to a temporary file in the same directory, is fsynced, is renamed into place, and the directory is fsynced.

- `init`: the key file is written first with exclusive create (`O_EXCL`), then `vault.json`. A crash between the two leaves an orphan key. The next `init` creates a new `keyId`, and the orphan is harmless; `doctor` can list it.
- `put`: either the old ciphertext or the new one is visible, never a torn file. Concurrent puts to one key from different revisions' provider instances are last-writer-wins, because each key is its own file.
- `delete`: unlink, then fsync the directory.

**Backup and restore.** Backup carries `vault.json` and the ciphertext, but no key. Restoring on the same host works because the key is still in place. A different host needs both of these:

- `effectory vault key export <id> > file`, which writes the key to stdout and is explicit.
- `effectory vault key import <id> < file`, which checks that the file belongs to that `keyId` by attempting to decrypt any one secret.

State the protection plainly. It protects ciphertext at rest in the repository, its backups and its git history from anyone who lacks the key file. It does **not** protect against the same OS user, a process running as that user (including all task and extension code), a key file stolen together with the repository, or memory inspection.

**Administration RPC.** Admin calls go through the daemon only, which is the single writer and uses the active revision's `Registry.vaults`. Each operation, its validation and its errors:

- `list`: no input; returns `{id, providerId, capabilities}[]`.
- `keys(vault)`: requires `provider.list`, otherwise `Unsupported`.
- `put(vault, key, value)`: `value` is a `Schema.Redacted(String)` field of at most 64 KiB, encoded on the wire with `RedactedFromValue` in the RPC schema only. Requires `provider.put`.
- `delete(vault, key)`: requires `provider.remove`.
- `read(vault, key)`: deliberate raw read; returns the value.
- `init(vault)`: local provider only.

Typed RPC errors are `UnknownVault` (with the available names), `Unsupported`, and the three vault errors.

The CLI reads values only from stdin or `--from-file`. There is no `--value` flag, and it refuses an interactive TTY on stdin unless `--prompt` is given (no echo). `read` needs `--reveal` and writes the bare value to stdout, plus a newline only when stdout is a TTY.

**No receipts.** `put` is naturally idempotent, so a retry writes the same value. `delete` returns whether the key existed. Neither records a receipt, fingerprint or value hash (F12). Operation history, if recorded, holds `{vault, key, action, outcome, time}` only. Task-side `put` is possible in the types, but it is outside v1's documented surface and outside the managed promise.

---

## 11. Access

The runtime is a trusted, single-owner local process, and extensions are privileged. **v1 has no vault allow-list.** The static declaration is the task's `R` (`Vault<"credentials">`), which the type checker enforces. A runtime allow-list would duplicate that declaration while securing nothing in-process.

A possible later step is an inspection field derived from `vaults:` plus task requirements, listing which vault each task may read. That is a contract guard and is explicitly not a sandbox. There is no multi-user authorization or remote isolation, and the parent must not imply either.

---

## 12. Swamp parity inventory

| Swamp behavior | v1 | Note |
| --- | --- | --- |
| Named vaults and local encrypted provider | ✔ | Different key model (§10) |
| Extension providers | ✔ | Through a Layer factory (A1) |
| get, put, list, delete, has | get/put/list/delete ✔; `has` ✖ | `has` adds little when `get` can return `Option` at the provider level |
| Fresh value on every attempt, no caching | ✔ | F5 |
| Redaction of logs and artifacts | partial ✔ | Reject or omit at managed boundaries; binary artifacts excluded (§9) |
| `read-secret` CLI | ✔ | `read --reveal` |
| Audit trail of reads and writes | ✖ | Candidate follow-up; operation history covers writes only if added |
| Annotations, put tags, refresh hooks | ✖ | Deferred; refresh belongs in provider code |
| Sensitive output fields (auto-store to vault) | ✖ | Deferred; needs a Schema-annotation design, and rejection covers the safety half |
| Workflow `vaults:` allow-list and serve grants | ✖ | §11 |
| `vault migrate`, rename, remove-with-reference-scan | ✖ | Deferred |
| Remote workers, team grants | ✖ | There is no such host |

---

## 13. What the parent draft must not do

- Make `Redacted` the durability guarantee, or describe value matching as "scrubbing".
- Read environment variables of the same name as a fallback for a missing secret. Provider bootstrap may use `Config` explicitly, in its own Layer.
- Put concrete secret values, defaults or a provider into `Vault.make`'s spec.
- Introduce `VaultStorage`, a provider registry, or a task-context `vault` field.
- Claim protection for binary artifacts, child processes, stdout or transformed values.

---

## 14. Genuine user decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Spelling A (`Credentials.get`) or B (`VaultStorage`) | **A** (§4) |
| D2 | Vault errors stay typed (authors declare `Vault.Errors` or use `orDie`), or `Task.make` accepts them implicitly as host failures | **Typed**, with `Task.make` unchanged |
| D3 | Accept `Vault.LocalStore` as the first host-provided application service (`Application<Vault.LocalStore>`) | **Accept.** The alternative, a user-configured absolute path, breaks across clones and restores |
| D4 | Free-string secret keys, or a declared key catalog in the vault spec (typo-checking and `doctor` for missing keys, but no dynamic keys) | **Free strings in v1.** A catalog can be added later without breaking |
| D5 | Reads outside an invocation, such as application-level Layers or standalone Effects: allow as unmanaged, or reject | **Allow and document** |
| D6 | Key location and restore: a key outside the repository plus explicit export/import, versus an operator-supplied key file or env var only | **Outside the repository, plus export/import**; operator key sources later |

The parent can settle these itself without asking the user: `remove` versus `delete` as the method name, the placeholder wording, and the exact limit values (256 values, 64 KiB, the 8-byte minimum).

## 15. Assumptions to verify before implementation approval

1. **A1:** a dynamic import from an extension's contract entry to its implementation entry survives archive validation and loading (§7).
2. **A2:** `taskLogger` can read the invocation `Context.Reference` through `options.fiber`, including for logs emitted from task-local Layer finalizers (F13; [inference]).
3. **A3:** catching defects inside the interpreter's activity body, before the `Activity.make` exit schema, covers every handler defect, including interruptions during finalizers, without changing replay classification.
4. **A4:** the registry check adds acceptable overhead at the JSON budget sizes: up to 256 needles against payloads of at most the JSON budget. A focused benchmark is needed, not a full suite.

Before the user is asked to approve an implementation, the following evidence is still required:

- Restart, retry and rotation tests through a real daemon with a canary: the value must be absent from SQLite, events, lake, logs, bundle and backup.
- Crash injection for `init`, `put` and `delete`.
- The installed-extension provider path compiled against generated bindings.

No full repository checks were run for this document. Only the scratch probes in §3 were run.

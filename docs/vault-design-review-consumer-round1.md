# Vaults: consumer design review, round 1

Status: **design input for the parent draft. Not reviewed from the Effect perspective, not user-approved, not implemented.** Every `Vault.*` name, CLI command, RPC and storage layout below is _proposed_. Snippets marked _stand-in_ compiled or ran against a scratch stand-in for feasibility only. They are not the implementation.

Inputs: [vault-research.md](vault-research.md), current source in `packages/`, pinned Effect 4.0.5, and Swamp's [vaults.md](../vendor/swamp/design/primitives/vaults.md) and `src/domain/vaults/`.

Evidence labels used below:

- **[source]**: read from the current worktree or the Swamp vendor tree.
- **[probe]**: run on 2026-11-05 in the session scratchpad, outside the checkout, with the synthetic value `canary-not-a-secret-0123456789`. No real credentials, accounts or environment secrets were used. No production file was changed.
- **[assumption]**: not verified. It needs a probe or a decision before implementation.

---

## 1. Recommendation in one page

**One vault definition is one ordinary Effect service.** It is a pure spec that declares its secret names and their string codecs. The backend is chosen by a Layer, with the implementation as the second argument. Tasks read through the service and get `Redacted` values, plus typed, value-free errors that fit `Task.make`. Operators administer the vault through daemon RPC and a `vault` CLI group, and values never appear in argv. The first-party backend is a daemon-owned, AES-256-GCM encrypted local store whose key is kept **outside the repository**. Extension backends plug in as the same second argument. The host adds no `TaskContext` field. It does add an invocation-scoped internal service that lets managed persistence paths scrub, or refuse to persist, values read in the same attempt.

```ts
// PROPOSED consumer surface (shape verified by stand-in, section 11)
export const Credentials = Vault.make({
  id: "credentials",
  secrets: {
    "github-token": Schema.NonEmptyString,
    deploy: Schema.fromJsonString(
      Schema.Struct({ user: Schema.String, password: Schema.String })
    ),
  },
});

const token = yield * Credentials.get("github-token"); // Redacted<string>, E = Vault.SecretError

export default Application.make({
  tasks,
  workflows,
  vaults: [Credentials],
}).provide(Vault.layer(Credentials, Vault.local)); // operator
// tests:      Vault.layer(Credentials, Vault.memory({ "github-token": "fixture" }))
// extension:  Vault.layer(Credentials, Vault.fromExtension(AwsSecrets, (b) => b.secretsManager({ prefix: "prod/" })))
```

---

## 2. The complete consumer path

### 2.1 Operator provisions a local encrypted vault

```ts
// effectory.ts (PROPOSED)
import { Application, Task, Vault, Workflow } from "@offtree/effectory-sdk";
import { Effect, Redacted, Schema } from "effect";

export const Credentials = Vault.make({
  id: "credentials",
  secrets: { "github-token": Schema.NonEmptyString },
});

const OpenIssue = Task.make(
  {
    id: "acme/open-issue",
    version: 1,
    replay: "manual",
    input: Schema.Struct({ title: Schema.String }),
    success: Schema.Struct({ number: Schema.Number }),
    error: Vault.SecretError, // or Schema.Union([MyError, Vault.SecretError])
  },
  ({ title }) =>
    Effect.gen(function* () {
      const token = yield* Credentials.get("github-token");
      return yield* createIssue(Redacted.value(token), title); // unwrap only at the I/O call
    })
);

export default Application.make({
  tasks: [OpenIssue],
  workflows: [Release],
  vaults: [Credentials],
}).provide(Vault.layer(Credentials, Vault.local));
```

```sh
effectory vault init          # creates the key outside the repo and prints its path plus a backup warning
effectory validate            # the revision loads; `credentials` is declared with 1 secret, 1 missing
```

### 2.2 Put a secret without plaintext in argv

```sh
effectory vault put credentials github-token                  # TTY: no-echo prompt
gh auth token | effectory vault put credentials github-token --stdin
effectory vault put credentials github-token --file ./token.txt --if-absent
# -> credentials/github-token version 1 (40 bytes)
effectory vault describe credentials
# github-token  Present  v1  2026-11-05T10:12:03Z     (never a value)
```

There is no `--value` flag. `put` decodes the value with the declared codec from the active revision before storing it. A failure reports only `Value does not match credentials/github-token`, never the Schema issue text (§9, T3).

### 2.3 The task consumes it through Effect DI

`Credentials.get("github-token")` has type `Effect<Redacted<string>, Vault.SecretError, typeof Credentials>`. The requirement flows into `Application`'s `R` like any other service, and `.provide(...)` discharges it [probe: stand-in type check]. Misspelling a secret name is a compile error [probe].

### 2.4 Substitute a test Layer

```ts
// PROPOSED; stand-in verified
const result = Task.test(OpenIssue, { input: { title: "x" } }).pipe(
  Effect.provide(
    Vault.layer(
      Credentials,
      Vault.memory({ "github-token": "fixture-not-secret" })
    )
  )
);
```

This needs no new `Task.test` option. A missing key yields `SecretNotFound { vault, secret }`, and a codec failure yields `SecretInvalid { vault, secret }`. Neither carries a value [probe].

### 2.5 Swap to a downloaded extension provider

```sh
effectory extension add github:acme/effectory-aws-secrets --bind AwsSecrets
```

```ts
import { AwsSecrets } from "./effectory.extensions.ts";

export default Application.make({
  tasks,
  workflows,
  vaults: [Credentials],
}).provide(
  Vault.layer(
    Credentials,
    Vault.fromExtension(AwsSecrets, (backends) =>
      backends.secretsManager({ prefix: "prod/" })
    )
  )
);
```

Task code does not change. Only the Layer's second argument changes. Provider bootstrap credentials, such as an AWS profile or keys, come from ordinary `Config` inside the backend, read from the **daemon's** environment (§9, T9). `vault put` and `vault delete` route to the backend in the active revision when the backend supports them. Otherwise they fail with an "unsupported by backend" message.

### 2.6 Rotate a secret while a run waits

```sh
effectory workflow run acme/release --background   # parks at an approval
effectory vault put credentials github-token --stdin --if-version 1 < new.txt   # -> v2
effectory run approve <run> <wait>                 # the next task reads v2
effectory run events <run>                          # SecretRead credentials/github-token v2 (no value)
```

Each `get` reads the backend. Nothing is cached across `get` calls, attempts or restarts. A retry attempt or a restarted, replayed task reads the current value. A completed durable activity is not recomputed to pick up a new credential. A value already unwrapped inside a running attempt stays stale until that attempt ends. Values read during **Application** Layer construction are revision-lived and do not rotate (§5, T6).

### 2.7 Back up and restore

```sh
effectory daemon stop && effectory backup ../snap
# Snapshot includes 1 vault (2 encrypted secrets). The vault KEY IS NOT INCLUDED.
# Escrow it with: effectory vault key export --to <path>
effectory restore ../snap ../restored        # same host: the key is found by repositoryId
effectory vault key import --from key.escrow # other host; fingerprint must match, otherwise refused
```

---

## 3. Assessing the two illustrative read shapes

|  | **A: per-vault service** `Credentials.get("k")` | **B: one storage service** `storage.get(Credentials, "k")` |
| --- | --- | --- |
| Effect DI | Each vault is its own `Context` key. `R` names exactly the vaults a task uses. | A single host-provided service, like `ArtifactStorage`, that is excluded from `R`. Which vault a task uses is invisible in its type. |
| Provider selection | An ordinary `Layer` per vault through `Application.provide` or `Task.provide`. | Needs a vault-to-backend registry inside the host, which is a second DI mechanism. |
| Test substitution | `Effect.provide(Vault.layer(V, Vault.memory(...)))` works today [probe]. | Requires a fake for every vault, plus a new `Task.test` option or host shim. |
| Task-local override | `Task.provide(Vault.layer(...))` works through existing memo maps. | Not expressible without new API. |
| Extension parity | Matches the existing `.exports.Client` service pattern [source: examples/extensions]. | Diverges from it. |

**Recommendation: A.** `yield* Credentials` returning the handle also works. `Credentials.get` is sugar for it. B is the `ArtifactStorage` shape, which is right for host-owned capabilities, but it is wrong for a backend the consumer must be able to choose and replace.

---

## 4. Proposed signatures

```ts
// PROPOSED; all names are subject to Effect review
export declare namespace Vault {
  /** A secret is stored as a string. Its codec decodes that string. Schema.String is the common case. */
  type SecretCodec = Schema.Codec<unknown, string, never, never>;
  type Secrets = Readonly<Record<string, SecretCodec>>;

  interface Definition<
    Id extends string,
    S extends Secrets,
  > extends Context.Key<Definition<Id, S>, Handle<S>> {
    readonly kind: "Vault";
    readonly id: Id;
    readonly secrets: S;
    readonly get: <K extends keyof S & string>(
      secret: K
    ) => Effect.Effect<
      Redacted.Redacted<S[K]["Type"]>,
      SecretError,
      Definition<Id, S>
    >;
    readonly getOption: <K extends keyof S & string>(
      secret: K
    ) => Effect.Effect<
      Option.Option<Redacted.Redacted<S[K]["Type"]>>,
      SecretInvalid | VaultUnavailable,
      Definition<Id, S>
    >;
  }
  interface Handle<S extends Secrets> {
    /* get and getOption, without R */
  }

  function make<const Id extends string, const S extends Secrets>(spec: {
    readonly id: Id;
    readonly secrets: S;
    readonly description?: string;
  }): Definition<Id, S>;

  // Implementation as the second argument. It is acquired once per Layer build.
  interface Backend {
    readonly read: (
      secret: string
    ) => Effect.Effect<
      Option.Option<Redacted.Redacted<string>>,
      VaultUnavailable
    >;
    readonly write?: (
      secret: string,
      value: Redacted.Redacted<string>
    ) => Effect.Effect<{ readonly version?: string }, VaultUnavailable>;
    readonly remove?: (
      secret: string
    ) => Effect.Effect<boolean, VaultUnavailable>;
    readonly describe?: (
      secret: string
    ) => Effect.Effect<
      Option.Option<{ readonly version?: string; readonly updatedAt?: string }>,
      VaultUnavailable
    >;
  }
  type Implementation<E, R> = (vault: {
    readonly id: string;
    readonly secrets: readonly string[];
  }) => Effect.Effect<Backend, E, R | Scope.Scope>;

  function layer<Id extends string, S extends Secrets, E, R>(
    vault: Definition<Id, S>,
    implementation: Implementation<E, R>
  ): Layer.Layer<Definition<Id, S>, E, Exclude<R, Scope.Scope>>;

  const local: Implementation<never, never>; // host-backed; see section 6
  function memory(
    values: Readonly<Record<string, string>>
  ): Implementation<never, never>;
  function fromExtension<D extends Extension.Definition, E, R>(
    extension: Extension.Installed<D> | D,
    select: (backends: D["vaultBackends"]) => Implementation<E, R>
  ): Implementation<E | DefinitionError, R>;

  // Value-free, JSON-safe errors. Usable in spec.error and in retry.when.
  class SecretNotFound {
    _tag: "SecretNotFound";
    vault: string;
    secret: string;
  }
  class SecretInvalid {
    _tag: "SecretInvalid";
    vault: string;
    secret: string;
  }
  class VaultUnavailable {
    _tag: "VaultUnavailable";
    vault: string;
    reason:
      | "Unreachable"
      | "Unauthorized"
      | "KeyMissing"
      | "KeyMismatch"
      | "Corrupt";
  }
  const SecretError: Schema.Union<
    [typeof SecretNotFound, typeof SecretInvalid, typeof VaultUnavailable]
  >;
}
// Application.make gains `vaults?: readonly Vault.Definition[]`. Extension.make gains `vaultBackends?`.
```

Decisions embedded here:

1. **Declared secret names, typed by codec.** Undeclared names are a compile error for tasks. `vault put` refuses names the active revision does not declare unless `--undeclared` is given, which supports staging ahead of a deploy. Dynamic or unbounded key sets are out of scope for v1 (§10).
2. **Errors are typed, value-free tagged errors in `E`.** They are not `TaskRuntimeError`. The reason is retry. `TaskRuntimeError` becomes a `Host` failure, and Host failures are never retried. Only `Domain` errors whose `_tag` is listed in `retry.when` are retried [source: interpreter.ts]. With `error: Vault.SecretError` in the spec, `retry: { when: ["VaultUnavailable"] }` type-checks, and a wrong tag is rejected [probe]. The cost is one union member per task spec. If a spec omits it, `Task.make` fails to compile [probe], which forces the choice. `Effect.orDie` remains the explicit "fail hard" option.
3. **Values are `Redacted`, labelled `vault/secret`.** `Redacted.make(v, { label })` renders as `<redacted:credentials/github-token>` [probe], which helps debugging without exposing the value.
4. **`Application.make({ vaults })` is required for administration.** Tasks reveal vault use only through erased `R`, so the daemon cannot discover vaults for `vault list` or `put` routing without registration. The registry stores each definition and resolves its handle from the captured revision context. Duplicate ids on non-identical definitions are a `DefinitionError`, because the service key string is derived from the id. A registered vault that is never provided is a revision-load failure that names the vault.

---

## 5. Lifetime and freshness rules (source-grounded)

- **Backend clients live with the revision.** `Application.make` captures its services once per revision build [source: application.ts `Effect.context`, revisions.ts `Layer.buildWithScope`]. Old runs keep their pinned revision's backend. If a newer revision swaps local storage for AWS, **in-flight old runs still read the local store** until they finish. Keep both populated during a cutover (T8).
- **Values are never cached by Vault.** Every `get` calls `backend.read`. The local backend caches only key material in daemon memory.
- **Reads in task-local Layers (`Task.provide`)** happen inside the invocation. They are fresh per attempt and covered by exposure tracking. **Reads in Application Layers** happen once per revision load. That is fine for a provider's bootstrap credentials, but wrong for a credential that must rotate:

```ts
// Stale after rotation: built once per revision
app.provide(GitHubClientLive); // GitHubClientLive reads Credentials at build time
// Fresh per attempt: rebuilt for each invocation through the existing memo-map path
OpenIssue.provide(GitHubClientLive);
```

- **A handle retained beyond its invocation** still reads, but exposure tracking is absent, so nothing is scrubbed. After the revision Scope closes, the backend is finalized and reads fail with `VaultUnavailable`.
- **No read happens during spec construction.** `Vault.make` is pure. `Vault.layer` does not read secrets while it builds.

---

## 6. Local encrypted store and key ownership

**Recommended single model:**

- **Key:** 32 random bytes in `~/.config/effectory/vault-keys/<repositoryId>.key` (directory `0700`, file `0600`), created by `effectory vault init` with exclusive create (`wx`). The daemon reads it from `EFFECTORY_VAULT_KEY_FILE` instead when that variable is set (containers or CI), as an explicit operator choice. `repositoryId` already exists in `.effectory/credentials.json` [source: daemon.ts], and a backup or restore keeps it.
- **Fingerprint:** HMAC-SHA256(key, `"effectory-vault-key-check"`) is stored in `state.sqlite`. It is not a hash of a secret, and with a 256-bit random key it reveals nothing useful.
- **Ciphertext:** stored in `state.sqlite` in a `vault_secrets(vault, secret, version, nonce, ciphertext, key_fingerprint, updated_at)` table. Each write uses AES-256-GCM with a random 96-bit nonce and AAD = `format‖vault‖secret‖version`, so ciphertext cannot be moved between names or rolled back unnoticed. Putting it in SQLite rather than per-secret files lets one transaction cover ciphertext, version and receipt, which removes the partial-write crash windows. Backup already copies the database consistently because it runs offline.
- **Never silent regeneration.** If a fingerprint exists and the key is missing, the result is `VaultUnavailable { reason: "KeyMissing" }` for reads and `vault status`, plus a CLI hint to `vault key import`. A different key gives `KeyMismatch`. `vault init` refuses when a fingerprint exists. Crash order for init: write the key to a temp file, fsync, link without overwrite, then record the fingerprint. On a rerun, a key with no fingerprint and no ciphertext is adopted.
- **Single writer.** Only the daemon writes, under the repository lease. Tasks read through the daemon's own connection. The CLI never opens the store directly.

**What this protects:** a copied repository or backup, an accidentally committed `.effectory/`, or a synced folder, as long as the key file did not travel with it.

**What it does not protect:** anyone running as the operator's OS user, who can read the key file and the daemon bearer token, or root; any task or extension code, which is trusted, in-process code that can call any provided vault; and plaintext that leaked into run history (§8).

This is a deliberate difference from Swamp's default, where `auto_generate` writes `.key` beside the ciphertext under `.swamp/secrets/` [source: vaults.md §Secret Storage]. Swamp also offers SSH-key and `key_file` sources. OS keychains (macOS Keychain, libsecret) are deferred. They suit a single binary less well and are platform-specific.

---

## 7. CLI and RPC shape

```text
effectory vault init | status                        # key presence, fingerprint match, key path
effectory vault list                                  # active-revision vaults: id, backend, capabilities, secret count
effectory vault describe <vault>                      # per secret: Present|Missing|Unknown, version, updatedAt
effectory vault put <vault> <secret> [--stdin | --file PATH] [--if-absent | --if-version N] [--undeclared] [--request-key K]
effectory vault delete <vault> <secret> [--if-version N] [--request-key K]
effectory vault reveal <vault> <secret> [--yes]       # TTY confirmation unless --yes or --json; audited
effectory vault key export --to PATH | import --from PATH
```

**Input rules.** Without `--stdin` or `--file`, `put` prompts only on a TTY and otherwise fails. It never reads a flag value. Bytes are stored **exactly**. If the value ends in `\n`, `put` prints a warning ("value ends with a newline; use printf or --trim-newline"), because `echo token |` is the most common rotation bug. The value must be valid UTF-8, at most 64 KiB. Values shorter than 8 characters are accepted with a warning that they cannot be scrubbed (§8).

**RPC (ControlPlane group, proposed).** `VaultList`, `VaultDescribe`, `VaultPut`, `VaultDelete`, `VaultReveal`, `VaultInit`, `VaultKeyStatus`, `VaultKeyImport`. Payload values use `Schema.RedactedFromValue(Schema.String)` **only** on the `VaultPut` and `VaultReveal` wire. The server code then holds a `Redacted`. As the research probe showed, that codec encodes plaintext on purpose, so the RPC layer must never log payloads. Today's loopback HTTP plus bearer token [source: daemon.ts `authorize`] is the transport. That is acceptable for the single-owner model, and the doc should say so plainly. Errors reuse `OperationError` codes (`NotFound`, `Conflict`, `InvalidInput`, `Unavailable`), and messages carry names only.

**Request keys and retries.** The vault RPCs are mutations, so they follow the existing `requestKey` convention [source: rpc.ts]. Receipts are stored in the same SQLite transaction as the write: `{requestKey, op, vault, secret, resultVersion, valueMac, createdAt}`. Here `valueMac = HMAC-SHA256(HKDF(vaultKey, "receipt"), vault‖secret‖value)`. A replay with the same key and MAC returns the stored receipt without writing again. The same key with a different MAC is a `Conflict`. Receipts **never** store plaintext or an unkeyed hash, which could be brute-forced offline from a backup when the value has low entropy. Receipts expire after 24 hours, bounded by count. `--if-absent` and `--if-version` give compare-and-set semantics, so a delayed retry cannot overwrite a newer rotation. For extension backends the same MAC key is used, which means `vault init` is required before any daemon-routed put. `reveal` is a read and needs no receipt. It is recorded in operation history as `{vault, secret, at}`.

---

## 8. Redaction and persistence: what v1 honestly protects

`Redacted` prevents **accidental formatting** of an un-unwrapped value. It does not scrub anything. Probe results against the real `taskLogger` [probe]:

| Path | Result |
| --- | --- |
| `Effect.log(redacted)` | Stored as `[Log value omitted: ...]`, because the value is not JSON. Safe, but by accident. |
| ``Effect.log(`token=${Redacted.value(r)}`)`` | **Plaintext in SQLite telemetry** |
| `Effect.logError(..., Cause.fail(new Error(`auth ${value}`)))` | **Plaintext in SQLite telemetry** |
| `String(r)`, `JSON.stringify`, `Bun.inspect` | `<redacted>`; no leak |
| Built-in Schema messages (pattern, type, `fromJsonString`, JSON parse) | No value in the message text |
| A custom `Schema.makeFilter` message that interpolates the input | **Leaks** |

Recommended v1 protection. This is required, not deferred. Without it, encryption at rest is undone the first time someone logs a header.

1. **Exposure tracking (internal, not a `TaskContext` field).** `Task.execute` provides an invocation-scoped host service next to `ArtifactStorage` and `Tag.Values` [source: task.ts]. `Vault.layer`'s handle registers each value it returns: the encoded string, plus string leaves of at least 8 characters for JSON codecs. At most 64 values are tracked per attempt.
2. **Scrub host text sinks** for that attempt by replacing exact and JSON-escaped occurrences with `<redacted:vault/secret>`. The sinks are task log messages and error text, progress messages, and the `TaskRuntimeError` message that becomes the Host failure detail.
3. **Refuse, never rewrite, typed payloads.** If the encoded success value, a domain error's detail, a JSON artifact payload or its publication tags contain a tracked value, the attempt fails with `TaskRuntimeError { code: "SecretInOutput", message: "... credentials/github-token" }`. Rewriting would break schemas and digests.
4. **Emit a `SecretRead {vault, secret, version}` run event** on each successful read. It is useful when debugging a rotation and carries no value.

**Not protected in v1, stated plainly:** binary artifacts; transformed values (base64, hashes, substrings shorter than the threshold); values shorter than 8 characters; the daemon's raw stdout and stderr, which `console.log` writes to `.effectory/daemon.log` [source: main.ts spawn] (excluded from backup, but persistent); child processes; network calls; reads outside an invocation (Application Layers, retained handles); and anything the task returns or publishes in a form that does not match.

---

## 9. Traps and the recommended handling

| # | Trap | Handling |
| --- | --- | --- |
| T1 | A missing secret surfaces as a non-retryable host failure | Use typed `SecretNotFound` in `E`. Operators fix the value and rerun. Add `VaultUnavailable` to `retry.when` only for transient backends. |
| T2 | Fallback to an environment variable of the same name | Never. `Vault.memory` and `Vault.local` read only their own store. A backend may use `Config` for its **own** bootstrap credentials. |
| T3 | Schema errors echo values | `SecretInvalid` drops the issue entirely, because custom filter messages leak [probe]. The same applies to `put` validation and `Tag`-style copying of `error.message`. Do not reuse `tag.ts`'s `error.message.slice(...)` pattern. |
| T4 | `Schema.RedactedFromValue` or `toCodecJson(Redacted)` in a task, artifact or error schema persists plaintext | Document it. Add a definition-time lint for these schemas inside Task, Artifact and Workflow boundaries if AST inspection proves reliable [assumption]. |
| T5 | Unwrapped values in logs and errors | Scrubbing as described in §8. Teach "unwrap at the I/O call". |
| T6 | Credentials read in Application Layers do not rotate | §5 example. `vault describe` and `SecretRead` events make staleness visible. |
| T7 | `put` ignores a trailing newline | Store exact bytes and warn. Offer an opt-in `--trim-newline`. |
| T8 | Provider swap with in-flight old runs | Old runs use their pinned revision's backend. Document the cutover: populate the new backend, deploy, and drain old runs before deleting local values. |
| T9 | The extension backend reads the daemon's environment, which an auto-started daemon inherited from whichever shell started it | A backend build failure fails the revision load and names the vault, not values. `effectory validate` surfaces it. Recommend `EFFECTORY_*`/profile configuration or restarting the daemon from the right shell. |
| T10 | Key lost or mismatched after a restore | `KeyMissing` / `KeyMismatch`, never regeneration. The backup output warns, and `vault key export/import` provides escrow. |
| T11 | A request key reused with a different value | MAC receipts give `Conflict`. CAS flags guard against delayed retries. |
| T12 | `reveal` output in shell history or scrollback | Output goes to stdout only. Confirm on a TTY. The event is audited. Never include values in `describe` or `list`. |
| T13 | Duplicate vault ids or module copies | The key string is derived from the id. `Application.make` rejects non-identical definitions that share an id. |
| T14 | Secrets as task input | Inputs are persisted JSON. Docs say never to do this. There is no sensitive-argument marking (gap). |

---

## 10. Parity with Swamp (honest)

| Swamp capability | v1 | Notes |
| --- | --- | --- |
| Named vaults, built-in local encryption, extension providers | Yes | Key is kept outside the repo by default, where Swamp colocates it |
| get / put / list-keys / delete / read-secret | Yes | `describe` provides list-keys and presence |
| Existence checks | Partial | Presence via `describe` when the backend can answer, otherwise `Unknown` |
| Fresh read per attempt, no value cache | Yes | Matches Swamp's "Lazy Evaluation" and "Caching Strategy" |
| Audit trail (writes always; reads opt-in, JSONL) | Partial | Admin operations and reveals go in operation history; task reads are `SecretRead` run events; there is no separate audit file or query command |
| Value-based redaction of stdout, stderr, logs and artifacts | Partial | Scrubbing of managed text sinks plus refusal for JSON outputs; no stdout or binary coverage |
| Sensitive output fields stored into vaults, sensitive method arguments, typed `Secret` sentinels | **No** | Largest gap, and needs its own design |
| Workflow `vaults:` allow-list and serve grants | **No** | Type-level `R` only; single trusted owner; no in-process sandbox is claimed |
| Annotations and provider tags (`--label`) | No | Deferred |
| Refresh hooks | No | Deferred |
| Vault migrate, rename, remove | No | Manual reveal-then-put is a documented workaround, though it routes plaintext through a pipe |
| Shell secret handoff (`__SWAMP_VAULT_N`), remote-worker capability service | N/A | Effectory tasks pass values explicitly; there are no remote workers |
| Dynamic key names (`vault.get(name, expr)`) | No | Only declared names in v1 |

---

## 11. Probe and stand-in evidence

Scratch directory: `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/57e6986f-bf49-4019-b1dc-349ab0ec1b5b/scratchpad/vault-probe/`. It contains `vault-standin.ts`, `consumer.ts`, `run.ts`, `runtime-probe.ts`, `schema-probe.ts` and `issue-probe.ts`. The checkout's `node_modules` is symlinked in, so it uses Effect 4.0.5 and the workspace SDK.

- **Types** (`tsc` exit 0 with the repo's strict options): `Credentials.get` infers `Redacted<string>` and `Redacted<{user; password}>`; an unknown secret name is an error; `Application.make` with the task has `R` exactly `typeof Credentials`, and `.provide(Vault.layer(...))` leaves `never`; `Task.test(...).pipe(Effect.provide(memory layer))` has no remaining services; an omitted `SecretError` in `spec.error` is a compile error; `Effect.orDie` compiles; `retry.when: ["VaultUnavailable"]` compiles and `["Nope"]` is rejected. The stand-in uses `Context.Service` plus `Object.assign` and an `as unknown as` cast. A real implementation needs Effect review of that construction. The stand-in does **not** include `Application.make({ vaults })`, the host exposure service, `Vault.local` or `fromExtension`.
- **Runtime** (`Task.test` + `Vault.memory`): success; missing secret gives `{"_tag":"SecretNotFound","vault":"credentials","secret":"deploy"}`; JSON codec mismatch gives `SecretInvalid` with no canary in the serialized error; an empty string under `NonEmptyString` gives `SecretInvalid`.
- **Logging and formatting:** the table in §8.
- **Not probed:** AES-GCM storage, key-file crash ordering, daemon RPC payload logging, backup output text, dynamic import from an installed extension, the exposure-tracking cost on large outputs, and `Redacted` equality and hash semantics (`Equal.equals` compares by value [probe], which is harmless here but worth noting).

---

## 12. Recommended first deliverable

**In scope:** `Vault.make`, `get`/`getOption`, `SecretError`; `Vault.layer` with `memory` and `local`; `Application.make({ vaults })`; the local AES-GCM store in SQLite with an out-of-repo key, init, status, export and import; the RPC and CLI listed in §7, with request-key MAC receipts and CAS; exposure tracking with sink scrubbing, output refusal and `SecretRead` events; a backup note in the output; and docs covering §5, §8 and §10.

**Second slice, which can be separate if the Extension change needs its own review:** `Extension.make({ vaultBackends })` and `Vault.fromExtension`, which load lazily through `installed.load()` so contract modules stay handler-free [source: extension-task-consumption.md]. Exporting a backend factory from the **contracts** module would violate that rule unless it dynamically imports its implementation, and whether a relative dynamic import works inside an installed archive is unverified [assumption].

**Acceptance evidence before implementation approval:**

- A real-daemon test: put, then run to an approval, rotate with `--if-version`, approve, and assert that the next task saw v2 and the events show `SecretRead v2`.
- A restart-at-wait test: the replayed task reads the current value, and no completed activity is recomputed.
- A canary sweep that greps the `state.sqlite` bytes, the backup directory, operation history, receipts, telemetry and `daemon.log` after a put, read, log, failure and reveal. The only canary occurrence allowed is in `daemon.log` when the test deliberately calls `console.log`.
- Crash injection at each init and put step.
- A key-missing restore test and a key-mismatch test.
- A test with a `Task.provide` local Layer versus an `Application.provide` Layer that shows the staleness difference.
- Tests that an unknown secret, a bad codec and an unsupported backend `put` produce value-free errors.

## 13. Decisions for the parent draft

1. Use read shape **A**: the per-vault service with `Credentials.get(name)`. Reject B.
2. Declare secret names with string codecs in the spec. Undeclared puts require `--undeclared`.
3. Use typed, value-free `Vault.SecretError` in `E`, not `TaskRuntimeError`, so retries stay possible.
4. Choose the backend with `Vault.layer(def, implementation)`. Use `Vault.local`, `Vault.memory` and, later, `Vault.fromExtension`.
5. Make `Application.make({ vaults })` required for administration and discovery.
6. Use the local store in `state.sqlite` with the key outside the repository, explicit `vault init`, no silent regeneration, and key export/import for escrow.
7. Never put values in argv. Store exact bytes with a trailing-newline warning, CAS flags, and MAC-keyed request-key receipts.
8. Treat exposure tracking with sink scrubbing and output refusal as **required** for v1, and state the unprotected paths explicitly.
9. Add no `TaskContext` field. The exposure service is host-internal and invocation-scoped, like `ArtifactStorage`.
10. Ship extension backends as a second slice, through a lazily loaded `Extension.make({ vaultBackends })` that needs Effect and consumer review of the Extension change.
11. List the §10 gaps in the parity docs: sensitive outputs and arguments, allow-lists and grants, annotations, refresh hooks, migration, and dynamic keys.

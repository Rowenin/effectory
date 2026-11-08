# Vaults: consumer contract review, round 2

Reviewer: Claude (consumer, operator and API-clarity view). Subject: the frozen [draft 1](vault-api-draft.md), read together with [research](vault-research.md), [persistence evidence](vault-persistence-evidence.md), and both round-1 reviews ([Effect](vault-design-review-effect-round1.md), [consumer](vault-design-review-consumer-round1.md)).

Status: **review only. It approves nothing, the draft is not user-approved, and no implementation is authorized.** No production file was changed. The draft was not edited.

**Verdict: not ready for presentation to the user.** The consumer shape is sound and close to final: per-vault typed handles, string codecs, `Vault.layer(definition, implementation)`, the protected accessor and handle, and SQLite ciphertext with an external key. The blockers are operational. Some recovery paths deadlock. Storage growth can permanently break backups. Several signatures that the draft says must be settled before presentation are still missing. One evidence claim is stated as fact when it has not been tested. Each blocker below comes with the smallest correction.

Evidence labels:

- **[source]**: read in this worktree at the cited location.
- **[scratch]**: run on 2026-11-05 in this session's scratchpad, outside the checkout, against the workspace's pinned Effect 4.0.5, SDK and Bun 1.4.3. Only synthetic values were used (`canary-not-a-secret-0123456789`, `prod/credentials/k`). These runs are feasibility evidence for a stand-in, not tests of an implementation.
- **[inferred]**: reasoned from source but not run.
- **[decision]**: an operational or product choice that must be written down explicitly, either by the parent or by the user (§11).

---

## 1. Blockers and the smallest corrections

| # | Blocker | Smallest correction |
| --- | --- | --- |
| B1 | **Daemon-start deadlock.** Every retained revision (up to 128) builds its application Layer when the daemon starts, and a single failure aborts the catalog [source: `revisions.ts:161–186`, `yield* loadApplication` inside the loop]. All admin commands except key export/import are online RPCs. Three ways to hit it: (a) an application-level Layer reads a secret that was later deleted; (b) `Vault.local` acquisition checks init or key state; (c) an extension backend fails acquisition because its bootstrap `Config` is missing from the daemon's environment. In each case the daemon cannot start, so `vault put`, `vault init` and `describe` cannot run to repair it. | Add three rules. (1) A `Vault.local`/`Vault.memory` implementation's acquisition performs no I/O that can fail on vault state; init, key and metadata problems surface only from `read`/admin operations. (2) The Backend contract states that acquisition must not perform network I/O or fail on missing remote credentials. Bootstrap problems surface as `VaultUnavailable` on first read. (3) For reads made during host revision build, the user chooses between **reject** (recommended: fail with `VaultFailure{reason:"Unmanaged"}`, while still allowing reads in standalone Effects and tests with no host) and **allow, plus an offline `vault put --offline` repair path** (§11 U3). The draft's "unmanaged reads are allowed" is incomplete until one of these is chosen. |
| B2 | **Vault data can permanently break backup.** Backup caps are 1 GiB in total, 128 MiB per file and 50,000 entries [source: `backup.ts:35–37`]. At the draft's limits, the worst case is 128 vaults × 256 keys × 64 KiB ≈ **2 GiB of ciphertext**, plus 128 × 256 × 64 = **2,097,152 receipts**. At roughly 300–600 bytes per row, the receipts alone come to about 0.6–1.2 GiB. All of it lives in the single `state.sqlite` file, which also holds run history. Once the file passes 128 MiB, `effectory backup` fails with `LimitExceeded`, and the draft offers no way to shrink it. | Add **store-wide** budgets that are enforced before commit and reported by `vault list`. A starting point (§11 U5): total ciphertext ≤ 16 MiB, at most 8 receipts per key **and** at most 4,096 receipts per store with oldest-first eviction, tombstones bounded as in B3, and at most 128 distinct vault IDs stored, orphans included. `put` over budget fails `LimitExceeded` before mutation and names the recovery command. Say plainly that vault rows share the 128 MiB backup file limit with run history. Name the file: this review recommends `state.sqlite`, which reuses the lease and the offline-consistent copy. |
| B3 | **Some state can never be removed: orphaned keys, orphaned vaults and lost keys.** (a) A key removed from the declaration cannot be administered: no `--undeclared`, and `describe` lists declared names only. Its ciphertext, tombstone and receipts stay forever and travel in every backup. (b) A vault removed from the application has the same problem. (c) A lost key leaves ciphertext that cannot be decrypted. `init` refuses to replace it, and `delete` needs the MAC key for its receipt. The vault is dead and cannot be reset. | (1) `describe` also lists **stored-but-undeclared** names as `Undeclared`, with their version and no value. `delete` accepts them: deletion needs no codec, and `put` still requires a declaration. (2) Add one offline command, `effectory vault reset <vault> --discard`, run with the daemon stopped under repository ownership. It removes the ciphertext, receipts, tombstones and key metadata for that vault ID, whether or not the ID is registered. It never touches key files. (3) Make `reset` safe from resurrection by keeping a per-vault **version floor** (B4). |
| B4 | **Version semantics are correct only while tombstones live forever.** The draft's chain (absent v0 → v1 → delete v2 → recreate v3) correctly blocks resurrection [assessed: §6.1]. Any bounding or reset of tombstones (needed for B2 and B3) would bring back version `0` for a key that already existed. A delayed `--if-version 0` create could then resurrect a deleted credential. | Keep a non-secret `vault_floor(vault, floor)` row that survives `reset`. An absent key reports `version = floor`, which is `0` only when nothing has ever been stored. Each new version is `max(current, floor) + 1`. `reset` and tombstone pruning set the floor to the highest version issued so far. A request whose `expectedVersion` is below the floor fails `Conflict`. This is one integer column. It keeps "never reused" true under bounded storage. |
| B5 | **Retries break after a provider change, and the old store cannot be administered.** Admin commands route to the _active_ revision. The draft tells operators to keep the old local store populated until pinned runs finish, but once the active revision uses another provider, nothing can rotate, delete, describe or reconcile receipts in that old store. A retried `put` returns `Unsupported` rather than its original receipt. | Give every vault command the existing `--revision` flag, the same convention as `task`/`workflow` [source: `main.ts:70`]. It targets any retained revision's registered vault, codec and provider. Receipt lookup runs against the backend that revision names. Together with B3's `reset`, this covers the drain and cleanup of an old store. |
| B6 | **Signatures the draft itself requires are missing.** The draft says reviewers "must resolve the exact Backend/LocalStore signatures and the local create/delete/retry precondition". It gives Backend only in prose, gives no `LocalStore` type, uses "actor-scoped" receipts without defining an actor, and has no admin reply or conflict shape. | Adopt the signatures in §4. They are minimal, and the codec and Layer parts are type-checked [scratch]. Publish **no** third-party mutation contract in this slice. Local mutation stays a host-internal adapter until a remote writable backend has its own review. |
| B7 | **The extension-backend claim lacks evidence, and the consumer steps are missing.** The draft says extension read backends "ship in this slice via the **tested** installed-provider path". Nothing has been tested. The draft's example also omits the install command and the revision activation step. | Reword the claim to "must ship; gated on proof gate 6". Add the real command sequence (§3). Add the probe results in §8, which raise feasibility but do not replace the gate. |
| B8 | **Managed redaction misses persisted string fields and can be defeated by truncation.** (a) Publication `key` and `tags`, through both `context.publish` and `ArtifactStorage`, are persisted strings that the table omits [source: `task.ts:34–37`; key is identifier-checked at `task.ts:226`, tags are free strings]. (b) `taskLogger` truncates `Error.message` to 2,000 characters and `name` to 200 before storage [source: `task-logger.ts:11–12`]. A secret that straddles the cut is persisted as a prefix, and the prefix never matches. | Add publication key and tags to the table, with the same rejection as the artifact value. Define matching against each sink's **pre-truncation** text. Replace the field first, then truncate. State that matching is "contains a verbatim occurrence", not equality. |

None of these changes the consumer-facing task API. B1, B3, B4 and B5 add one rule, one offline command and one flag.

---

## 2. What was tested, read and inferred

| Claim | Evidence |
| --- | --- |
| Draft codec bound `Schema.Codec<unknown, string, never, never>` accepts `String`, `NonEmptyString`, `NumberFromString`, `fromJsonString(Struct)` and branded strings. It rejects `Schema.Number` and codecs with decoding services. | [scratch] `tsc` with the repo's strict options, exit 0, and every `@ts-expect-error` fired |
| Per-key result inference: `Redacted<string>`, `Redacted<number>`, `Redacted<{readonly user; readonly password}>`. An undeclared key is a compile error. | [scratch] same stand-in |
| `Vault.layer(def, local)` leaves `Application<LocalStore>`, so `satisfies Application<never>` fails as intended. Providing a different vault does not satisfy the requirement. `Task.test(...).pipe(Effect.provide(layer(def, memory)))` has `R = never`. | [scratch] same stand-in. It does **not** include `Application.make({ vaults })`, the protected handle or the registry. |
| An async decoder **cannot** be distinguished at the type level. `decodeUnknownSync` throws a non-Schema error ("Sync adapter can only throw schema errors"), and `decodeUnknownEffect` succeeds. The canary did not appear in either error. | [scratch] `transformEffect` with `Effect.sleep` |
| A contracts-module factory that does `import("./provider.mts")` bundles, with Bun `splitting: true`, into a separate chunk. Importing `contracts.mjs` does not evaluate the provider. Calling the factory does not either. Running the returned Effect does, exactly once. | [scratch] the Bun.build config copied from the test publisher [source: `test/fixtures/published-extension.ts:81–100`] |
| Re-bundling that consumer as a single-output, unsplit revision bundle, using the application bundler's settings [source: `application-bundle.ts:48–118`], inlines the chunk **and keeps it lazy**. The provider was evaluated 0 times at import and once after the Effect ran. | [scratch] |
| Every retained revision is built at daemon start, and one failure fails the catalog | [source] `revisions.ts:161–186`. That this stops the daemon is [inferred]. |
| New source activates only on restart or a validated extension mutation | [source] `docs/implementation-status.md:12` |
| `extension add github:OWNER/REPO@TAG [--as NAME] [--asset effectory.tgz] [--trust] [--request-key K] [--expected-revision R]`. A facade binding is generated **only** when `--as` is given. | [source] `main.ts:1246–1276`, `extension-bindings.ts:89`, `extension-resolver.ts:235` |
| There is no top-level `effectory validate`. `task validate <id>` and `workflow validate <id>` check **input** against a definition. | [source] `main.ts:339–355, 1410–1411` |
| Revision manifests record **every** locked package digest, so an extension used only through `.exports` is still trust-checked on restart | [source] `revisions.ts:224–230` |
| `OperationError` carries only `code` and `message` | [source] `runtime/src/protocol.ts:110–130` |
| `Task.test` records progress and publications in memory. It has no task logger, and it does not run the interpreter's second encoding. | [source] `task.ts:524–690` |
| Extension validation imports the contracts and entry modules but checks only the manifest's tasks, workflows, artifacts, implementations and patches. A backend export is never exercised. | [source] `extension-validation.ts`, `extension-validate-worker.ts` |
| Not run: archive verification with an extra chunk, install through a fake `gh`, emitted `.d.mts` for a factory typed with `Vault` types, restart pinning, compiled-binary host module resolution, AES/SQLite crash behavior, and any redaction mechanism | — |

---

## 3. End-to-end consumer and operator walkthrough, corrected against real commands

The draft's examples type-check as a shape [scratch], but they are missing imports and the operator steps. A walkthrough suitable for presentation:

```ts
// contracts.ts: pure, importable from tests and extensions
import { Vault } from "@offtree/effectory-sdk"; // PROPOSED export
import { Schema } from "effect";
export const Credentials = Vault.make({
  id: "credentials",
  secrets: { "github-token": Schema.NonEmptyString },
});

// effectory.ts
import { Application, Vault } from "@offtree/effectory-sdk";

import { Credentials } from "./contracts.ts";
import { CheckCredential } from "./task.ts";
export default Application.make({
  tasks: [CheckCredential],
  vaults: [Credentials],
}).provide(
  Vault.layer(Credentials, Vault.local)
) satisfies Application.Application<Vault.LocalStore>;
```

```sh
# 1. The source edit becomes a revision only on restart (or an extension mutation).
effectory daemon stop && effectory daemon start
# 2. Builds without init (B1 rule 1); describe shows NotInitialized.
effectory vault describe credentials
effectory vault init credentials
# 3. First write requires the never-created token.
effectory vault put credentials github-token --file token.txt --if-version 0
effectory task run example/check-credential --input '{}'
# 4. Rotation.
effectory vault describe credentials            # github-token Present v1
effectory vault put credentials github-token --file new.txt --if-version 1
# 5. Escrow and backup (offline).
effectory daemon stop
effectory vault key export credentials --output /secure/credentials.key
effectory backup ../snap
```

Installed extension backend, using actual commands only:

```sh
effectory extension add github:acme/effectory-secrets@v1.0.0 --as AwsSecrets --trust
# --as is required: without it no facade export is generated.
# If any revision requires a not-yet-provided vault Layer, the candidate fails to build.
```

```ts
import { AwsSecrets } from "./effectory.extensions.ts";
Application.make({ tasks: [CheckCredential], vaults: [Credentials] }).provide(
  Vault.layer(
    Credentials,
    AwsSecrets.exports.secretsManager({ prefix: "prod/" })
  )
);
```

Two things to state. First, the `extension add` revision is validated with the **current** `effectory.ts`. Adding the extension and then switching the Layer is therefore two steps: add, edit, then restart. Second, `extension add` fails today if it is run after `effectory.ts` already references `AwsSecrets`, because the binding does not exist yet. Show the order [inferred from `extension-manager.ts:148` and the facade overlay].

Round 1 used `effectory validate` (top-level, nonexistent) and `--bind` (it is actually `--as`). The draft correctly avoids both but shows no command at all. Use the sequence above.

**Test path.** `Task.test(CheckCredential, { input: {} }).pipe(Effect.provide(Vault.layer(Credentials, Vault.memory({...}))))` type-checks with `R = never` [scratch]. Its guards can only cover what `Task.test` itself performs: success and declared-error encoding, `publish` (value, key and tags) and `progress`. Logs, defect serialization and the interpreter's second encoding exist only in the daemon. Reword "Task.test must exercise the same managed guards" to name these four paths. Leave the rest to the real-daemon canary gate.

---

## 4. Missing signatures (B6), proposed minimal forms

```ts
// Public. Exactly what extension authors implement in this slice.
export interface Backend {
  readonly providerId: string; // namespaced; "effectory/*" reserved for first-party
  readonly read: (key: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, VaultUnavailable | VaultFailure>;
  /** Metadata only. Must not fetch or decrypt a value. Omitted means describe reports Unknown. */
  readonly inspect?: (key: string) => Effect.Effect<KeyState, VaultUnavailable | VaultFailure>;
  readonly list?: Effect.Effect<ReadonlyArray<string>, VaultUnavailable | VaultFailure>;
}
export type KeyState =
  | { readonly _tag: "Absent"; readonly version: string }   // local: the floor, "0" if never stored (B4)
  | { readonly _tag: "Present"; readonly version: string }
  | { readonly _tag: "Deleted"; readonly version: string }  // tombstone
  | { readonly _tag: "Unknown" };
export type Implementation<E = never, R = never> =
  (spec: { readonly id: string; readonly keys: ReadonlyArray<string> }) =>
    Effect.Effect<Backend, E, R | Scope.Scope>; // acquisition: no failing I/O on vault state (B1)

// Opaque, host-provided. No public methods or constructor in this slice.
export interface LocalStore { readonly [LocalStoreTypeId]: typeof LocalStoreTypeId }
export const LocalStore: Context.Key<LocalStore, LocalStore>;
export const local: Implementation<never, LocalStore>;
export function memory(values: Readonly<Record<string, string>>): Implementation; // read-only for admin (see below)
```

- **LocalStore.** The draft says that "a pure library consumer can supply its own LocalStore Layer". No use case was given, and supporting it makes the store's file layout a public API. Keep LocalStore opaque. Library tests use `Vault.memory`. The loader provides LocalStore for every retained revision **and** for candidate preparation, because both go through `loadApplication`. Revisions built before this feature ignore it.
- **Memory backend.** "Test fixtures only" is not enforced. A production application can provide `Vault.memory`, and if it accepted admin writes, `put` would succeed and then vanish on restart. Give memory no admin mutation capability. `vault list` should then show `effectory/memory`, read-only.
- **Admin replies.** `VaultPut` and `VaultDelete` return `{ vault, key, version, outcome: "Committed" | "Replayed", current: KeyState }`. `Replayed` tells the operator that a retried request matched an earlier receipt, which may now be stale. A `Conflict` is an `OperationError` whose message has a fixed format, `expected version X; current <state> Y` (version tokens are non-secret). `describe --json` stays the structured path. Fold a structured conflict into the success union only if the user wants script-friendly CAS (§11 U7).
- **Receipt scope.** Drop "actor-scoped". The host has one trusted owner. The receipt key is `(vault, key, requestKey)`. If a known `requestKey` arrives with a different MAC payload, the reply is `Conflict`. The MAC covers `op ‖ vault ‖ key ‖ expectedVersion ‖ value bytes`; delete has an empty value.
- **Errors.** Retry selects only on the top-level `_tag` [source: interpreter, round-1 F8]. With the draft's grouping, `when: ["VaultUnavailable"]` would also retry `Closed` (a programming error), `Corrupt` and `KeyMismatch`, none of which retrying can fix. Move `Closed`, `Corrupt` and `KeyMismatch` into `VaultFailure`. `VaultUnavailable` keeps the operator-recoverable or transient reasons: `Unreachable | Unauthorized | KeyMissing | NotInitialized`. `getOption`'s error type must exclude `VaultSecretNotFound`. Add `Unmanaged` to `VaultFailure` if U3 chooses reject.

---

## 5. Lifetime, the host requirement and application-level reads

- **Per-call protection** for both `.get` and the yielded handle is the right contract. Because the handle reads the caller's invocation `Context.Reference` at call time, a handle captured by an _application-level_ client Layer is still managed and fresh when that client calls `get` inside a task [inferred from the draft's mechanism]. Show this. It is the main reason application-level client construction is less risky than it sounds. Only reads made _during revision build_ are unmanaged.
- **Unmanaged build-time reads** have four consequences that the user must see. They run for each of up to 128 retained revisions at every daemon start. They never refresh. They are not registered, so a task that returns such a value is **not** rejected. A failure stops the daemon (B1). The examples should show building a credentialed client in `Task.provide` as the recommended path.
- **`satisfies Application.Application<Vault.LocalStore>`** replaces the documented `<never>` check only for applications that use `Vault.local`. Show both forms. Say that LocalStore is the only host-provided requirement, so a stray additional requirement still fails the check.
- **Key directory resolution must match** between the daemon (init, read) and the offline CLI (export, import). An auto-started daemon can inherit a different `HOME` or `XDG_CONFIG_HOME`. Specify the order, `EFFECTORY_KEY_DIR` › `$XDG_CONFIG_HOME/effectory/keys` › `~/.config/effectory/keys`, and have `describe` and `doctor` print the resolved directory and key ID (both non-secret).

---

## 6. Administration semantics

### 6.1 `--if-version`, required

Assessment: **keep it required.** The chain absent v0 → create v1 → delete v2 (tombstone) → recreate with `--if-version 2` → v3 blocks the scenarios the brief names:

| Delayed request | Current state | Result |
| --- | --- | --- |
| Original create (`--if-version 0`) after its receipt was evicted | Deleted v2 | `Conflict`. No resurrection. |
| Rotation `--if-version 1` | Deleted v2, or Present v3 | `Conflict`. No stale overwrite. |
| Exact retry of create, receipt still held | Any | `Replayed` with v1 and current state |
| Same request key, different value | Any | `Conflict` |
| Exact retry after a **codec** change made the original value invalid | Any | `Replayed`. The receipt is checked before codec validation, which is correct for idempotency. `current` shows the stale state. |
| Retry after a **provider** change | Active revision is remote | Today `Unsupported`. With B5's `--revision` targeting the old revision, `Replayed`. |
| Any request after a `reset` or a pruned tombstone | Absent at the floor | Correct only with B4's floor |

Ergonomics: a first write needs `--if-version 0`, and the operator usually runs `describe` first. That is acceptable. The conflict message must state the current version (§4) so a deliberate retry needs no second lookup.

### 6.2 Receipts and exhaustion

A window of 64 per key is larger than any realistic operator retry. Over a store it is unbounded in practice (B2). After eviction, a delayed retry gets `Conflict`, which cannot be told apart from a lost race. That is acceptable if documented, and the recovery is `describe`. Recommend a small per-key window plus a store-wide cap (B2), and drop age-based expiry. Receipts need the MAC key, so with `KeyMissing` even an exact retry fails `Unavailable`. State this.

### 6.3 Codec ownership

`put` validates against the targeted revision's codec only, which is the active one by default. In-flight runs on an older revision with a stricter codec can fail `VaultSecretInvalid`. **[decision]** Either accept and document active-only (recommended), or validate against every retained revision that declares the key. The second blocks legitimate codec migrations. Separately, the draft's synchronous-decoding restriction for `put` is unnecessary. The daemon handler is effectful, so decode with `decodeUnknownEffect` **before** the synchronous SQLite transaction, and keep compare-and-set inside it. That removes the "valid for reads, rejected for writes" asymmetry. An async decoder fails sync decoding with a distinct non-Schema error [scratch], so the current wording would surface a confusing declaration error.

`describe` must not decrypt by default. An explicit `describe --check` that decodes in the daemon and reports only `Valid | Invalid` per key is useful after a codec change. **[decision]** for the parent: include it or defer it.

### 6.4 CLI input and output details

- The existing convention is `--input` and `--input-file PATH|-` [source: `main.ts:65–68, 110+`]. The draft's `--stdin` plus `--file` is a second convention. The smallest consistent form is `--file PATH`, where `-` means stdin, and exactly one is required. The draft's `--stdin` is acceptable if the user prefers it. **[decision]**
- With no hidden prompt in this slice, reading from stdin when **stdin is a TTY** echoes the secret as it is typed. Refuse that case with a value-free message.
- `put` reads files in the CLI, not the daemon, enforces 64 KiB with a bounded read, and requires UTF-8. If delivery is uncertain, print `Retry with --request-key K`, as `run` does [source: `main.ts:385–396`].
- `reveal` writes exact bytes to stdout and adds no newline. That raw-stdout default is the brief's deliberate choice, and I accept it. It returns the _stored_ string without decoding, so an invalid value can still be recovered. It refuses when the shared `--json` flag is set. `--output` uses `wx` with mode 0600, as the draft says. The CLI must bypass `print`.
- `put` should write one value-free stderr note when the value is shorter than the matching threshold ("not eligible for value-based protection"). `describe` must not show this, because that would disclose a length class.

---

## 7. Local key, export, import, backup and restore

- **Init crash sequence.** The draft says "adopt the same newly created key only when unambiguous", which is not yet a procedure. Specify it: (1) write a `Pending{keyId}` metadata row; (2) create the key file with `wx` and mode 0600, fsync the file and its directory; (3) write `Ready{keyId, keyCheck = HMAC(key, "effectory-vault-key-check" ‖ keyId)}`. On rerun: `Pending` with no file creates the key; `Pending` with a 32-byte file adopts it; `Ready` refuses. Import verifies `keyCheck`. That is what "verifies key identity against authenticated metadata" requires, and the draft never names the check.
- **Per-vault or per-repository key [decision, U6].** The draft's `vault init <vault>` and `vault key export <vault>` imply one key per vault, which could mean up to 128 escrow files. Recommend one root key per repository store, with per-vault subkeys derived by HKDF over the vault ID and purpose: one `init`, one export, one import. Keep the per-vault command shape only if the user wants per-vault escrow.
- **Lost key.** Today this is permanent (B3c). `vault reset --discard` is the bounded recovery. State in the backup output that without the escrowed key, restore yields vaults that can only be reset.
- **Rotation.** Without master-key rotation, deleting or rotating a value does not remove it from older backups or from free SQLite pages that can still be decrypted with the same key. Say so in "does not protect", or set `PRAGMA secure_delete` for vault writes. **[decision]** for the parent.
- **Restore** onto the same host, as a second copy, shares the key ID and key file. That is harmless, but say so. Neither copy can delete the key file through Effectory.

---

## 8. Downloaded extension backends

**Usefulness.** A read-only remote backend is the common production case: values are managed in the provider's own console or CLI, and Effectory supplies typed lazy reads, freshness per attempt, provider swap by Layer, and managed protection. It is worth shipping in this slice, with an optional `inspect` (§4) so that `describe` reports presence and version rather than always `Unknown`.

**Feasibility** [scratch, §2]: a contracts-module factory with a relative dynamic import survives the publisher's split build and the host's single-file revision bundle, and it stays lazy in both. This supports the draft's "import facade without executing provider side effects".

**Gaps the draft must name, not defer:**

1. No first-party packer exists. Authors reproduce the fixture's `Bun.build({ splitting: true, ... })` and manifest by hand. Document that the backend chunk must be listed in `manifest.files`.
2. The validator never exercises backend exports. A broken factory is found only at revision build, which is the B1 hazard. Rule (2) of B1 turns this into a read-time `VaultUnavailable`.
3. Bootstrap `Config` is read from the **daemon's** environment, which an auto-started daemon inherited from whatever shell started it. Carry over round-1 T9 and say this in the walkthrough.
4. `providerId` is self-declared. Reserve the `effectory/` prefix and require namespaced IDs, so that `vault list` cannot show a spoofed `effectory/local`.
5. Proof gate 6 must additionally show: archive verification with the chunk; install through a fake `gh` (the test pattern; no operator command installs from a local archive [source: `extension-source.ts:35`]); emitted `.d.mts` that keep `Implementation` typing; and a restart that pins the old provider.

---

## 9. Managed protection: limits the user must approve, stated exactly

These are limitations, not internal details. The user must see each one:

| Limit or exclusion | Why it matters to a consumer |
| --- | --- |
| Values shorter than 8 UTF-8 bytes are not matched | PINs, short passwords and numeric codes are **never** rejected or omitted |
| String leaves of structured (JSON-codec) values are registered | **False positives.** Non-secret fields of 8 bytes or more in a JSON credential, such as `host`, `region` (`us-east-1`), `username` or endpoint URLs, will reject legitimate task outputs and blank log lines that mention them. Recommend: document "keep non-secret configuration out of vault JSON". Field-level sensitivity is a deferred alternative. **[decision U4]** |
| Number and boolean leaves | Not registered as leaves. If matching runs on the persisted serialized text (recommended), a long numeric secret stored as a raw string is still caught, while a short one never is. Specify which approach is used. |
| Custom decoders that transform | Not covered (already stated) |
| Binary artifacts, daemon console output, files, child processes, HTTP | Not covered (already stated) |
| Values read during revision build | Not registered (§5). Depends on U3. |
| Publication key and tags | **Must be added** (B8) |
| Log truncation at 2,000 and 200 characters | Must match before truncation (B8) |
| Task context surface | `RuntimeContext` exposes `tags`, `occurrence`, `key`, `publish`, `publishBytes` and `progress` [source: `task.ts:55–78`]. Of the persisted, author-controlled strings, all are covered except `publishBytes`, which is excluded, once publication key and tags are added. `key(name)` and `tags` are inputs, not sinks. |
| Error text | `SecretInOutput` should name the vault and key (non-secret, and essential for diagnosis) but not the path or value. The draft's "no offending path" is fine, but it should not also suppress names. |

Rejecting typed outputs rather than rewriting them is correct. Matching never silently rewrites typed success, error or artifact values. Only untyped text fields are replaced as a whole.

---

## 10. Smaller clarity items the parent can settle without the user

- Fix the example imports (§3). Show `effectory daemon stop && effectory daemon start` as the activation step.
- `vault init` on a non-local provider fails `Unsupported`. `init` on an already-ready store fails `Conflict`.
- `describe` states: `NotInitialized | KeyMissing | KeyMismatch | Ready` per vault, and `KeyState` per key, including `Undeclared` (B3).
- `vault list` shows each provider's capabilities: `read`, `inspect`, `list`, `admin`.
- Operation history: the draft records no audit events. Either record vault mutations in the existing operation history as `{vault, key, op, version, outcome}`, or state that `effectory operation list` will not show them.
- Remove the word "tested" from the extension sentence (B7).
- Rename the matching promise to "contains a verbatim occurrence" throughout.

---

## 11. Explicit user decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| U1 | Per-vault typed handle, `Vault.layer(def, impl)`, string codecs, `Vault.Errors` in `E` | Accept (shape type-checked [scratch]) |
| U2 | `Vault.LocalStore` as an opaque host requirement (`Application<Vault.LocalStore>`) | Accept, opaque, with no public constructor |
| U3 | Reads during host revision build: reject with `Unmanaged`, or allow with an offline `put --offline` repair path | **Reject during host build**; allow in standalone Effects and tests |
| U4 | Managed-protection limits: the 8-byte minimum, JSON-leaf false positives, binary and I/O exclusions, unregistered build-time reads | Approve as listed in §9, or ask for field-level sensitivity in a later slice |
| U5 | Store budgets: ciphertext total, receipts per key and per store, stored vault IDs | 16 MiB; 8 per key and 4,096 per store; 128 IDs including orphans |
| U6 | One key per repository store (HKDF subkeys), or one key per vault | **Per repository** |
| U7 | Conflict as `OperationError` text, or as a structured success outcome | `OperationError` with a fixed message, plus `describe --json` |
| U8 | Required `--if-version` on every put and delete, with no force mode | Accept |
| U9 | Raw reveal to stdout by default; `--output` without overwrite | Accept (deliberate) |
| U10 | Offline `vault reset --discard` as the only recovery for a lost key or an orphaned vault | Accept |
| U11 | A read-only extension backend ships in this slice, gated on the extended proof gate 6 | Accept, with the gate as written in §8 |

---

## 12. Additions to the draft's proof gates

- **Gate 3 (lifetime):** start the daemon with (a) a retained revision whose application Layer reads a now-deleted secret; (b) an uninitialized `Vault.local`; (c) a failing extension bootstrap. Assert the behavior chosen in U3 and B1, and that recovery works.
- **Gate 4 (storage):** fill the budgets and assert `LimitExceeded` before mutation. Run `reset` and assert the version floor blocks a delayed `--if-version 0`. Assert that `describe` lists undeclared keys and that `delete` removes them. Assert that backup succeeds at full budget alongside a realistic run history.
- **Gate 5 (CLI):** refusal on a TTY stdin, `--revision` routing with receipt replay after a provider switch, the conflict message format, and key-directory mismatch diagnostics.
- **Gate 2 (redaction):** a canary in publication key and tags; a canary straddling the 2,000-character log cut; a JSON credential whose non-secret 8-byte-or-longer field appears in a legitimate output, asserting the documented false positive.

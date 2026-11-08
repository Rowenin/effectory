# Named vaults through Effect — reviewed proposal

Status: **user-approved and implemented**. The user approved separate vault definitions for different providers; per-key routing and remote mutation remain deferred. See the [consumer documentation](vaults.md) for the implemented API and [implementation evidence](implementation-status.md) for verification. The [consumer round-3](vault-review-consumer-round3.md) C1–C6 and [Effect round-3](vault-review-effect-round3.md) C1–C4 corrections are incorporated. [Resolution notes](vault-contract-resolution.md) record the choices and probes. This document preserves the reviewed proposal; its original feasibility probes are distinct from the implementation tests.

## The authoring API

A vault definition is an ordinary, specifically typed Effect service key. Its pure spec declares the secret names and their string codecs. The implementation is the second argument of `Vault.layer`. Applications and tests select providers with normal Effect Layers.

```ts
// PROPOSED: contracts.ts
import { Vault } from "@offtree/effectory-sdk";
import { Schema } from "effect";

export const Credentials = Vault.make({
  id: "credentials",
  secrets: { "github-token": Schema.NonEmptyString },
});
```

```ts
// PROPOSED: task.ts
import { Task, Vault } from "@offtree/effectory-sdk";
import { Effect, Redacted, Schema } from "effect";

import { Credentials } from "./contracts.ts";

export const CheckCredential = Task.make(
  {
    id: "example/check-credential",
    version: 1,
    replay: "idempotent",
    input: Schema.Struct({}),
    success: Schema.Boolean,
    error: Vault.Errors,
  },
  () =>
    Effect.gen(function* () {
      const token = yield* Credentials.get("github-token");
      // A real client unwraps at its outbound I/O boundary. Never return a token.
      return Redacted.value(token).length > 0;
    })
);
```

```ts
// PROPOSED: effectory.ts
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

```ts
// PROPOSED: test — no new Task.test option
import { Task, Vault } from "@offtree/effectory-sdk";
import { Effect } from "effect";

import { Credentials } from "./contracts.ts";
import { CheckCredential } from "./task.ts";

const check = Task.test(CheckCredential, { input: {} }).pipe(
  Effect.provide(
    Vault.layer(
      Credentials,
      Vault.memory({
        "github-token": "fixture-token-value",
      })
    )
  )
);
```

`Credentials.get(k)` is sugar for `(yield* Credentials).get(k)`. Both use the same typed, protected handle. Each vault remains a distinct requirement in R; supplying a different ID cannot satisfy it. A fake is a normal Implementation passed through Vault.layer, not a hand-written handle.

Each `Vault.make` call has a unique runtime Context key containing a random nonce, never a module-local counter. Runtime keys are not persisted; operator data uses the declared ID. The operator-facing `id` is separate. This prevents two same-ID definitions with different codecs from silently occupying one service slot. Registered duplicate IDs fail Application construction. Import the canonical definition from one contracts module; recreating it, or loading a duplicated SDK/module copy, does not supply the original service. TypeScript cannot distinguish two calls with exactly the same literal ID and codec type, so runtime identity remains necessary. All retained revision bundles may legitimately have their own same-ID definition instances.

## Types, codecs and errors

The intended public signatures use pinned Effect primitives:

```ts
// PROPOSED; HandleTypeId is private, not exported.
type SecretCodec = Schema.Codec<unknown, string, never, never>;
type Secrets = Readonly<Record<string, SecretCodec>>;
declare const HandleTypeId: unique symbol;

interface Handle<Id extends string, S extends Secrets> {
  readonly [HandleTypeId]: { readonly id: Id; readonly secrets: S };
  readonly get: <K extends keyof S & string>(
    key: K
  ) => Effect.Effect<Redacted.Redacted<S[K]["Type"]>, ReadError>;
  readonly getOption: <K extends keyof S & string>(
    key: K
  ) => Effect.Effect<
    Option.Option<Redacted.Redacted<S[K]["Type"]>>,
    Exclude<ReadError, VaultSecretNotFound>
  >;
}
interface Definition<
  Id extends string,
  S extends Secrets,
> extends Context.Service<Definition<Id, S>, Handle<Id, S>> {
  readonly kind: "Vault";
  readonly id: Id;
  readonly secrets: S;
  readonly get: <K extends keyof S & string>(
    key: K
  ) => Effect.Effect<
    Redacted.Redacted<S[K]["Type"]>,
    ReadError,
    Definition<Id, S>
  >;
  readonly getOption: <K extends keyof S & string>(
    key: K
  ) => Effect.Effect<
    Option.Option<Redacted.Redacted<S[K]["Type"]>>,
    Exclude<ReadError, VaultSecretNotFound>,
    Definition<Id, S>
  >;
}
function make<const Id extends string, const S extends Secrets>(spec: {
  readonly id: Id;
  readonly secrets: S;
  readonly description?: string;
}): Definition<Id, S>;
```

These are published under the SDK's `Vault` namespace and `@offtree/effectory-sdk/Vault`. Make validates and freezes the spec synchronously but performs no secret lookup. Vault IDs use the existing identifier rule. Secret names are 1–200 ASCII letters, digits, `.`, `_`, `-` or `/`, starting with a letter or digit. Names are public metadata. Limits are 256 declared keys per vault and 128 registered vaults per application. Dynamic secret names are a stated gap.

String-encoded codecs include String, refinements/brands, FiniteFromString and fromJsonString. An undeclared key is a type error and a runtime InvalidDefinition failure. Codecs with service requirements or non-string encodings are rejected by the types. Both reads and administrative put use `Effect.suspend(() => Schema.decodeUnknownEffect(codec)(raw))`, with a five-second cooperative decoding timeout. The suspension captures synchronous decoder throws as well as asynchronous failures. Inspect the Exit: propagate interruption without sibling decoder defects, map schema failures to InvalidValue, defects to DecoderFailed and timeout to DecodeTimedOut, always without values or Schema issues. Put decodes before its transaction and stores the original bytes, not a re-encoding. A timeout interrupts cooperative decoding; it cannot preempt blocking JavaScript or an uninterruptible user finalizer.

All errors are Schema tagged errors, with no raw value, Schema issue, provider exception or HTTP body:

| Error | Fields |
| --- | --- |
| VaultSecretNotFound | vault, key |
| VaultSecretInvalid | vault, key, reason: InvalidValue / DecoderFailed / DecodeTimedOut |
| VaultUnavailable | vault, reason: Unreachable / Unauthorized / KeyMissing / NotInitialized |
| VaultFailure | vault, optional key, reason: Unsupported / LimitExceeded / InvalidDefinition / Closed / Corrupt / KeyMismatch / Unmanaged |

`ReadError` and `Vault.Errors` are the TypeScript union and Schema union respectively. Task.make remains unchanged: tasks declare the union, combine it with domain errors, or handle it explicitly. Existing retries can select VaultUnavailable; permanent closed/corrupt/wrong-key errors do not use that tag. `getOption` returns None only for an absent key; an uninitialized local vault fails NotInitialized. Decoder failures and defects become value-free SecretInvalid errors while external interruption remains interruption.

No missing secret falls back to an environment variable. Provider bootstrap may use ordinary Effect Config explicitly, reading the daemon's environment, not the shell of a later CLI request.

## Backend, Layer and host service

The public provider contract is read-only in this slice. Remote mutations do not receive an unproven exactly-once contract.

```ts
// PROPOSED: names are under Vault.
interface ImplementationSpec { readonly id: string; readonly keys: readonly string[] }
type KeyState =
  | { readonly _tag: "Absent"; readonly version: string }
  | { readonly _tag: "Present"; readonly version: string }
  | { readonly _tag: "Deleted"; readonly version: string }
  | { readonly _tag: "Unknown" }
interface Backend {
  readonly providerId: string
  readonly read: (key: string) => Effect.Effect<
    Option.Option<Redacted.Redacted<string>>, VaultUnavailable | VaultFailure
  >
  // Metadata only: inspect must not fetch or decrypt a secret value.
  readonly inspect?: (key: string) => Effect.Effect<KeyState, VaultUnavailable | VaultFailure>
  readonly list?: Effect.Effect<readonly string[], VaultUnavailable | VaultFailure>
}
interface Implementation<out E = never, out R = never> {
  (spec: ImplementationSpec): Effect.Effect<Backend, E, R | Scope.Scope>
}
function layer<Id extends string, S extends Secrets, E, R>(
  definition: Definition<Id, S>, implementation: Implementation<E, R>
): Layer.Layer<Definition<Id, S>, E | DefinitionError, Exclude<R, Scope.Scope>>
function memory(values: Readonly<Record<string, string>>): Implementation
class LocalStore extends Context.Service<LocalStore, {
  readonly open: (spec: ImplementationSpec) => Effect.Effect<Backend, never, Scope.Scope>
}>()("@offtree/effectory-sdk/Vault/LocalStore") {}
const local: Implementation<never, LocalStore>
```

Only Vault.layer constructs the branded Handle. Plain Layer.succeed with a hand-written handle does not typecheck. Custom fakes use Implementation; casts or deliberate private-module access are outside the contract. Memory captures encoded fixture strings and is read-only for administration: it must never acknowledge a persistent put that disappears at restart. Its keys are not inferred from the eventual definition, so a misspelled fixture key is a runtime missing-key error; no misleading compile-time promise.

Backend provider IDs are namespaced metadata. `effectory/` is reserved; only built-in backend instances can claim it. The host uses a private WeakSet of the actual backend objects it creates; providerId or copied symbol properties confer no privilege. An invalid reserved-prefix claim fails Layer construction with the existing DefinitionError, included in Vault.layer’s error type alongside provider acquisition errors. Provider list results are validated and capped at 256 names, matching this slice's bounded catalog; exceeding that reports LimitExceeded rather than silently truncating. Backend acquisition captures its dependencies through normal Layer composition and may acquire scoped clients. Backend methods themselves have no remaining R.

The host creates **one LocalStore instance per daemon**, owning a lazily opened `.effectory/vaults.sqlite` connection and key cache, and supplies it to every retained and candidate revision build. Each open handle belongs to its revision Scope. Constructing LocalStore and its handles does not open, create, migrate or validate the database. The first vault operation opens it; file/schema failures fail that operation, never daemon startup. Repositories with no vault operations get no vault database. Doctor reports failures. Recover file-level corruption offline by restoring the vault database from backup, or moving the database and its WAL/SHM files aside together, losing access to every local vault in that store; per-vault reset does not repair database corruption. Open/local/memory construction performs no decryption and does not fail because keys or initialization are missing; operations report those states. Application<Vault.LocalStore> is the supported host export check for local vaults; other applications still use Application<never>. A different library host may implement LocalStore.open for reads, but that does not confer the built-in CLI's private local mutation adapter.

`Application.make({ vaults })` registers handles for administration and adds their services to R, even when no task reads them. Its generic uses a structural Registrable bound (`kind`, `id`, `key`) rather than invariant `Definition<string, Secrets>`. Runtime construction verifies canonical definitions and branded handles before the heterogeneous registry erases their generics. Unregistered provided vaults can serve tasks but are invisible to CLI administration. Missing services then surface at read time as missing-service defects naming the vault ID. Registration instead checks the handle during application construction. An extension task and its consumer must import the same canonical definition instance.

```ts
// PROPOSED addition to Application; existing names/types retain their meaning.
interface Registrable {
  readonly kind: "Vault";
  readonly id: string;
  readonly key: string;
}
function make<
  const T extends readonly RegisteredTask[] = readonly [],
  const X extends readonly Extension.Use[] = readonly [],
  const V extends readonly Registrable[] = readonly [],
>(spec: {
  readonly tasks?: T;
  readonly workflows?: readonly Workflow.Definition[];
  readonly schedules?: readonly WorkflowSchedule.Definition[];
  readonly artifacts?: readonly Artifact.Any[];
  readonly extensions?: X;
  readonly vaults?: V;
}): Application<
  Requirements<T> | Extension.Requirements<X[number]> | V[number]
>;
```

## Lifecycle and startup recovery

Provider clients live with their Layer Scope. Application providers are revision-owned and rebuild for every retained revision at daemon startup. Task-local Layers rebuild per attempt. The host does not cache loaded secret values: every get calls the backend, and completed durable activities reuse their saved result without re-reading secrets.

**Selected rule: vault reads during host revision construction are rejected with Unmanaged.** This prevents a revision that eagerly reads a mutable credential from being retained and later blocking startup when that credential changes. Standalone Effects remain supported. Handles built outside host ownership may serve unmanaged reads, which have no persistence protection unless called within a managed invocation. A handle built during revision construction or an invocation remembers that ownership and refuses reads without an invocation tracker. Thus starting a fresh root with Effect.runPromise inside a task cannot bypass tracking through that handle. Building an application-level client that captures the handle without reading it is valid; calls from inside tasks remain managed. Credentialed clients that actually read at acquisition belong on Task.provide.

This rule does not make arbitrary application/provider Layers infallible. Third-party providers should defer credential validation and network requests to operations. A Layer that deliberately reads missing bootstrap Config or performs failing network acquisition can still prevent a retained revision from loading, just as other application Layers can today. Fix the external bootstrap configuration and restart. No revision-pruning command exists today, so acquisition-time bootstrap configuration must remain available for every retained revision. Providers should defer bootstrap Config and credentialed client work to read operations; a provider that uses a local vault for bootstrap declares that vault in its implementation requirements and reads it lazily inside read, not during revision acquisition; any memoized client must respect its owning Scope and credential-rotation policy. Acquisition-time logs go to daemon output, outside managed run telemetry. This draft does not add a second lazy-Layer cache or promise that vault repair can fix arbitrary provider code. First-party local acquisition is infallible with respect to vault state; offline key/reset commands bypass application loading entirely.

Old runs retain their provider code. Switching an active revision from local to a remote provider does not migrate old runs. Keep the old provider available; online commands can target it with `--revision`. Rotating a value in the same backend affects the next read in either revision. Put validates only the targeted revision's codec, so a pinned older run may reject the new value with SecretInvalid.

An invocation has a host-owned tracker that remains alive through final Activity success/error encoding. Task.test owns its corresponding tracker. A fork that inherited a closed invocation cannot read more secrets; late managed logs/progress are omitted after clearing, without keeping plaintext indefinitely or claiming to supervise arbitrary detached fibers.

## Managed protection

This is an accidental-disclosure guard at managed persistence paths, not a sandbox. Trusted task/provider code can explicitly transform or send data through other I/O.

Before returning a read, register the raw stored string. If it parses as a JSON object/array, register its string leaves with depth at most 16 and at most 256 leaves; do not register property names. If decoding returns a different top-level string, register that too. Do not walk arbitrary decoded objects, invoke getters or inspect class instances. Register JSON-escaped variants when different. All variants count against 256 distinct strings and 1 MiB UTF-8 per invocation. The raw stored value is capped at 64 KiB. Exceeding a traversal/tracking bound fails before exposing the value.

**Only strings at least eight UTF-8 bytes long participate in value matching.** Shorter credentials remain valid but receive only Redacted inspection protection, not value-based detection. A put emits a value-free notice for a short value. Structured credentials register all raw JSON string leaves, including non-secret hosts/regions/usernames: these can cause legitimate output to be rejected. Keep ordinary configuration out of vault JSON. Field-level sensitivity is deferred.

Checks look for a verbatim occurrence in the final owned serialized JSON or pre-truncation text, not equality. Exact raw numeric text can therefore match serialized numbers; transformed values are not a guarantee. Match before truncating log Error.name/message. When a text field exceeds the bounded 64 KiB pre-scan limit and the tracker has registered needles, omit the entire field. No huge pre-validation string scan is allowed.

| Managed path | Behavior |
| --- | --- |
| Final encoded task success or declared error | Reject with non-retryable TaskRuntimeError code SecretInOutput; never rewrite typed data |
| JSON artifact value, publication key and tags | Reject before fingerprinting or commit; both ArtifactStorage and the legacy adapter |
| Binary publication key and tags | Same metadata rejection; binary content is not scanned |
| Log message/error and progress message | Replace the entire affected field before persistence |
| TaskRuntimeError message copied to host failure | Replace affected text before building ExecutionFailure |
| Defect text serialized by Activity | Sanitize matching defects while preserving other Cause reasons, including interruption |
| Managed log/progress after the tracker closes | Fixed late-output omission marker, never unscrubbed late content |

SecretInOutput names the vault/key as public metadata, not the matching value or offending output path. A secret should not be used as its own public identifier. Provider read/inspect/list and local admin operations run with task telemetry loggers suppressed: provider logs emitted before registration cannot be safely matched. This deliberately hides provider-internal Effect debug logs from run telemetry. Direct provider console/file/network I/O remains outside the promise.

**Excluded:** binary content; daemon console output; arbitrary filesystem writes, HTTP and child processes; transformed values beyond the registered raw/escaped/top-level-string forms; values read outside an invocation; short strings. No run-wide persisted secret registry is introduced. Pass key names through graph edges, not credentials. Ordinary inputs/tags/code literals can persist before task lookup and are not made secret by using the vault elsewhere.

Task.test shares guards for its success/error encoding, publication payload/metadata and progress. It does not pretend to test the daemon's logger, Activity defect serialization or second interpreter encoding; real-daemon tests cover those.

## Internal ownership implementation to verify

No new task-context capability or public RuntimeContext.secrets field is proposed. Use two private Context.References with stable unversioned keys: RevisionBuild (default false) and Invocation (default undefined). An invocation tracker takes precedence over the build marker. The interpreter and Task.test supply Invocation per attempt. Host revision construction sets RevisionBuild while **removing the Invocation entry entirely** from its input context, including when a revision build is triggered from within an attempt. Use Effect.updateContext with Context.omit at that boundary: explicitly providing undefined would leave a captured entry that shadows a later tracker. Application.make and application clients can then capture their contexts normally, with no special omission in Application.make. Read trackers structurally, not with instanceof.

Vault.layer records whether a handle was constructed under RevisionBuild or Invocation. Such a handle rejects untracked calls with Unmanaged. At call time, an open Invocation registers values; a closed one fails Closed; without Invocation, a build marker rejects the read. Only a standalone handle outside these ownership boundaries can read unmanaged. Re-providing an old attempt’s captured context may produce Closed; it must not reopen a tracker. Logger and progress closures hold their attempt’s tracker directly so late output cannot escape through a changed calling context.

Own the tracker with acquireUseRelease, which adds no Scope requirement. Close new reads after task-local finalizers complete, retain needles through the interpreter’s final success/domain-error/host-error encoding, sanitize the full Exit, then clear in release. For interruption plus finalizer defects, use the tested uninterruptibleMask + Effect.exit(restore(body)) form rather than catchCause/catchDefect, which do not run on external interruption. Map only matching Die reasons, preserving Interrupt and other reasons, before the Activity serializes its exit. Codec failures use the separate value-free mapping specified above.

The Effect reviewer probed propagation with real Task/Application and stand-in vault internals, including context-capturing clients and interrupted finalizers. A parent scratch probe additionally confirmed that omitting Invocation at the build boundary preserves a later tracker, while supplying undefined shadows it. Neither probe tests the future interpreter integration.

Cooperative JSON scanning must check an owned serialization and persist that same representation or its private decoded copy, not return a mutable producer object for later serialization. The benchmark found roughly 20–26 ms for a naive maximal scan; yield between bounded batches at async boundaries. The synchronous Logger path has separate smaller limits. These implementation mechanics are proof obligations, not claims about code that exists.

## Local storage, bounds and version tokens

The dedicated vaults.sqlite uses the repository lease and one daemon-owned connection. Ciphertext, metadata/version and receipt commit atomically. Keep encryption and receipt-MAC purposes separate; use authenticated encryption with per-write random nonces and associated data binding format, vault, key and version. Never persist plaintext values, full secret-bearing requests, ordinary unkeyed value hashes or raw exceptions in receipts.

Proposed store-wide limits:

- 16 MiB live ciphertext total; 64 KiB UTF-8 per stored value.
- 128 stored local vault identities, including removed declarations; reset frees an identity slot.
- 256 stored key records per vault, including undeclared and deleted keys. Old tombstones may be pruned when needed; live values are never pruned automatically.
- Newest eight receipts per vault/key and at most 4096 receipts across the store, evicting oldest first. Receipt caps never disable delete/reset.
- A 64 MiB physical database page cap, with a checkpoint/journal strategy that keeps the offline file under the builtin 128 MiB per-file backup limit. Deleting rows reuses free pages rather than promising automatic file shrinkage. Set the page cap on every connection, including offline commands. Leave secure_delete off; secure erasure is not promised. Checkpoint with TRUNCATE after reset/pruning and at clean close, and bound retained journals with journal_size_limit. A page cap does not cap an active WAL: prove database and WAL bounds separately under churn and unclean shutdown. Backup excludes vaults.sqlite-shm, preserves any necessary WAL, and performs no checkpoint or other source mutation itself.

Writes exceeding a logical budget fail LimitExceeded before mutation, naming describe/delete/reset as remedies. Deletion/reset must remain possible at the logical budget. A truly full filesystem may still require freeing external space before SQLite can write. These limits bound this feature's storage, not unrelated run history or the existing 1 GiB total backup limit.

Local versions are opaque string tokens backed by one persisted store-wide monotonic counter and one global absence token. Every successful put/delete gets a fresh counter value. Init, import and Pending/Ready transitions never advance this counter. Delete of an Absent or Deleted key returns NotFound without issuing a token, after checking for an existing retry receipt. Present/deleted rows retain their own tokens. A key with no row reports the absence token, initially `0` in a fresh store.

**Forgetting or resetting state advances the counter to a strictly new value and atomically updates the absence token.** It then removes the selected rows/receipts/metadata. This fences delayed requests even after tombstones or vault identities are forgotten. It changes tokens for other absent keys, which may produce a safe Conflict; existing present-key versions remain valid. Never reject an existing row merely because its token is below the absence token. Tokens are never reused within one store history, including after reset; counter exhaustion is a typed limit, not wraparound.

Example: create A v1, create B v2, delete B v3; forgetting B changes absence to v4. A still updates using v1, receiving v5. An old B recreation expecting v3 conflicts; a new one uses the observed v4. These semantics replace the earlier per-key floor suggestion. Restoring an older whole database restores its counters too; this is not anti-rollback protection against restoring a valid older backup. After restore, describe again before preparing any write.

When a put must prune to fit, check CAS against the pre-prune state first. Then prune the oldest eligible tombstone and its receipts, never the target key’s own row, and advance the absence token. Issue the new secret version after pruning, all in one transaction. Failure rolls back every change. This order avoids a create conflicting with the absence token it just advanced.

## Key ownership and recovery

**Selected model: one external root key per local vault.** This preserves `vault init <vault>` and isolates lost-key/reset recovery. It means multiple local vaults require multiple escrow files; that tradeoff is explicit for user approval. Derive separate encryption and MAC keys by purpose. Master-key rotation is deferred; individual secret-value rotation works.

Key directory precedence is `EFFECTORY_KEY_DIR`, then `$XDG_CONFIG_HOME/effectory/keys`, then `~/.config/effectory/keys`. Paths/key IDs are non-secret and describe/doctor show the resolved directory. Daemon and offline commands resolve it the same way; differing process environments can still point at different directories and must be diagnosed. Files/directories use 0600/0700 and are never overwritten with a new key silently. Key filenames use the globally random key ID, not the vault ID: repositories sharing the directory may each declare credentials. Init refuses a resolved key directory within the repository; doctor flags that configuration. Resolve symlinks and existing parent directories when checking containment, including for not-yet-created paths.

Init first commits Pending metadata with a stable random key ID, then exclusively creates and durably flushes the key file containing that identity and 32 random key bytes, then commits Ready metadata with a keyed identity check. Recovery adopts only a matching Pending file of the correct format when no ciphertext exists. If Pending has no key file in the resolved directory, rerunning init commits a fresh random key ID before creating a file, rather than risking different key bytes under one identity in two directories. Describe reports Pending as NotInitialized with an “init interrupted; rerun init” hint. Only init consumes a stored vault identity slot; registration, describe and failed put do not. A Ready vault with a missing/wrong key fails KeyMissing/KeyMismatch, never regeneration. Already-Ready init is Conflict; non-local init is Unsupported.

Offline export/import take repository ownership and do not load applications. Export creates a new 0600 file and refuses overwrite or a destination within the repository, using the resolved-path containment rule above. Import verifies the key ID and keyed check, and refuses replacing a different installed key. Neither sends a master key over RPC or accepts it in argv. An exported key file is a raw recovery credential, not an encrypted export.

Backup copies the repository tree. Keys are excluded only because they live outside it; plaintext input files or shell-redirected reveal output placed inside the repository would also be copied. Keep those files outside the repository and delete plaintext input files after use. Same-host copies reuse the key ID; another host needs import. Backup remains non-mutating and states that keys are external. Never delete external key files automatically: older backups may still need them. Deletion/rotation does not revoke older encrypted backups or promise erasure of old SQLite pages.

Offline `vault reset <vault> --discard` removes that local vault's ciphertext, receipts, tombstones and key metadata, whether registered or orphaned and even when its key is lost. It advances the global absence token in the same transaction and does not touch key files. Other vaults and their keys remain intact. New init gets a new key ID. Reset of an unstored vault returns NotFound and does not advance the absence token. This is an explicitly destructive recovery command; no automatic reset is performed.

## CLI and RPC

Online commands require `vault.v1` and accept existing `--repository` and optional `--revision`. Replies state the resolved revision. Codec/provider selection is pinned for the request. The default is the active revision; the old revision remains available for rotation, receipt lookup and cleanup during a provider switch. Offline reset/key commands target the local store and have no revision selector.

```sh
# PROPOSED: after writing the application source
 effectory daemon stop && effectory daemon start
 effectory vault list
 effectory vault describe credentials
 effectory vault init credentials
 # A fresh store reports token 0; otherwise copy the token from describe.
 effectory vault put credentials github-token --file ~/tmp/token.txt --if-version 0
 effectory task run example/check-credential --input '{}'
 effectory vault put credentials github-token --file - --if-version 1 < ~/tmp/rotated.txt
 effectory vault reveal credentials github-token
 effectory vault delete credentials github-token --if-version 2

 effectory daemon stop
 effectory vault key export credentials --output ~/escrow/credentials.key
 effectory backup ../snapshot
 # On another machine after restore:
 effectory vault key import credentials --file ~/escrow/credentials.key
```

`list` returns registered vault/provider IDs, capabilities and store usage/limits. `describe` reports NotInitialized, KeyMissing, KeyMismatch or Ready, declared keys plus stored-but-undeclared keys, key states/tokens, and codec descriptions for declared keys. Listing/inspection must not decrypt values. Remote metadata absence yields Unknown. Stored undeclared keys can be deleted or revealed, but put requires a declaration in the targeted revision. Entirely orphaned vaults are discoverable in the local-store portion of list and can be reset offline. To reveal/delete a renamed or removed vault online, select a retained revision that still registers it with --revision. If no retained revision registers it, only offline reset is available. Responses are bounded; describe's maximum union is 256 declared plus 256 stored names. Codec/schema serialization limits must fail clearly, not return secret data or silently omit fields.

Put requires `--file PATH`, with `-` meaning stdin, and accepts only regular files or pipes, refusing any terminal input source, including a path such as /dev/tty. It preserves exact valid UTF-8 bytes, including a newline; input is capped at 64 KiB before sending. A trailing line break produces the value-free notice “value ends with a line break; stored exactly”. There is no argv value, default echoing prompt or force mode. It requires `--if-version TOKEN`. Delete also requires that token; it can remove undeclared stored keys without a codec. Reveal returns stored bytes without codec validation, raw to stdout with no added newline; optional --output creates a new 0600 file without overwrite and refuses a resolved destination within the repository. Shell redirection cannot be inspected or protected by this option. Reveal refuses --json.

Put/delete accept optional --request-key; the CLI generates one when omitted and prints the same key in an uncertain-delivery hint, with --revision R when known. Otherwise the hint says to select the earlier revision if the active revision changed. Receipts are scoped to `(vault, key, requestKey)` in the local store: the host has one trusted owner. MAC covers operation, vault, key, expected token and exact value bytes. Check an existing receipt before codec/version checks so an exact retry returns its original commit even after an edit or rotation. A key reused with different payload is Conflict. After eviction, CAS still prevents stale overwrite/resurrection, but the old receipt cannot be recovered; describe gives current state. With a missing MAC key even receipt lookup fails KeyMissing. Reset clears the vault's receipts and fences their old expected tokens.

The mutation reply is `{ revision, vault, key, operation: Put|Delete, version, replayed, current: KeyState }`. On replay `version` describes the original commit, while `current` may be newer. Conflict remains existing OperationError code Conflict, with a value-free message naming expected/current token and state or request-key reuse; structured inspection is available through describe. No new task error joins Vault.Errors for operator conflicts.

Admin errors map to the existing OperationError codes:

| Condition | Code |
| --- | --- |
| Absent/Deleted on reveal/delete; unstored vault on reset | NotFound |
| NotInitialized, KeyMissing, KeyMismatch, Corrupt, Closed, provider unreachability or provider credential rejection | Unavailable |
| Unsupported, InvalidDefinition, undeclared put key, SecretInvalid, invalid input or prohibited path | InvalidInput |
| Logical storage/tracking/catalog limit | LimitExceeded |
| SQLITE_FULL, physical page cap or full filesystem | StorageFull |
| Expected-version mismatch or request-key payload reuse | Conflict |

Messages are value-free and name the vault and key where applicable, with a cause-specific remedy. Permanent and recoverable vault failures may share Unavailable at the admin boundary; task errors retain their finer distinction. Existing daemon authentication failures retain Unauthorized.

ControlPlane adds VaultList, VaultDescribe, VaultInit, VaultPut, VaultDelete and VaultReveal with Effect Schema payloads/replies. Offline key/reset operations are not RPCs. Public Backend has no mutation API: local admin uses a private host adapter, remote and memory providers report Unsupported before writing. There is no vault audit history in this slice and `operation list` does not pretend to include these receipts. No MCP adapter is implied.

## Installed extension workflow and evidence

```sh
# Existing command: install first, before referencing the generated export.
 effectory extension add github:acme/effectory-secrets@v1.0.0 --as AwsSecrets --trust
# Then edit source to select the provider below and restart.
 effectory daemon stop && effectory daemon start
```

```ts
// PROPOSED factory type; existing installed .exports mechanism
import { AwsSecrets } from "./effectory.extensions.ts";
Application.make({ tasks: [CheckCredential], vaults: [Credentials] }).provide(
  Vault.layer(
    Credentials,
    AwsSecrets.exports.secretsManager({ prefix: "prod/" })
  )
);
```

The extension exports an Implementation factory from its contract entry; it defers provider/client module import and acquisition until the Layer builds. Use Effect.tryPromise for a typed lazy-import failure. Every lazy chunk must be in manifest.files. No first-party packer is added; document the existing publisher recipe. Provider bootstrap credentials come from the daemon environment or explicit application services, with no same-name secret/env fallback.

The Effect reviewer tested real archive verification, cache restore, trust, generated bindings, consumer declarations, the subprocess validator, application bundle/revision loading, read/release, retained-bundle code pinning, fresh-process import and same-process catalog reload. Importing/calling the facade did not evaluate provider/client modules; building the Layer did. Thus no new Extension contribution kind or fromExtension helper is needed.

Limits of this evidence: the stand-in types were extension-local, not implemented SDK Vault types; the validator does not exercise provider factories; catalog reload was same-process. Implementation must repeat with real SDK exports, fake-gh CLI installation, compiled host modules and actual daemon death/restart. A broken lazy provider can still fail revision acquisition; this is reported rather than hidden by a fallback provider.

## User decisions and implementation gates

Present the coherent contract, not each internal function. Explicit user choices are: typed per-vault get/Layer shape and canonical definitions; declared codecs/error union; LocalStore host requirement; rejecting reads during host revision build; protection limits and suppressed provider telemetry; external per-vault escrow; required version checks, bounded deduplication and reset fences (including safe cross-vault conflicts for previously prepared creates); raw explicit reveal and destructive offline reset. No review is user approval.

Both focused reviews are resolved for presentation. Implementation gates include:

1. Real SDK type tests: identity/key/result inference, same-ID runtime isolation, branded handles, registered-but-unused services, custom provider E/R, test Layers, async codecs, error/retry tags and generated extension declarations.
2. Real-daemon canary sweep across JSON payload/metadata, success/errors/defects/finalizers and truncation; interrupted finalizer defects; a codec that emits only on its second encoding and an eagerly throwing decoder; late detached output. Pin exclusions and false positives honestly.
3. Rotation across retry/wait/restart, completed activity reuse, old-provider administration with --revision, concurrent isolation, revision-build refusal with Invocation absent, a build-context-capturing client, fresh-root runPromise refusal, task-local finalizer reads, infallible uninitialized local acquisition and external bootstrap-failure diagnostics.
4. Key Pending/Ready crash points, ciphertext/version/receipt atomicity, corruption and missing-key behavior, stored-orphan cleanup, receipt eviction, reset/prune stale-request fences, global limits and physical-page churn. Include CAS-before-prune at capacity, full receipt capacity, missing/corrupt database operation-time failure, shared-key-directory identity across repositories, and WAL/SHM behavior and backup exclusions after an unclean stop. No secret can appear in SQLite plaintext, receipts, events or revision bundles via a covered path.
5. CLI UTF-8/size/TTY handling, uncertain-delivery retries, exact raw reveal, output-file refusal, offline key/reset ownership, same-/different-host key directories, resolved-path containment refusals for keys and explicit output files, and backup at vault capacity. A filled unrelated run database is not a vault backup guarantee.
6. The installed extension path above, with a synthetic read backend and no live cloud credentials.
7. Cooperative scanner ownership/performance, pre-truncation logger bounds and scope cleanup through Activity persistence. Run the required typecheck, lint and test suite after implementation.

Deferred Swamp behavior: dynamic key names, field-level sensitive input/output vault references, refresh hooks, annotations, complete audit trails, migration/rename, master-key rotation, workflow allow-lists, team grants and remote-worker handoff. This is a useful vault slice, not full vault parity; the broader parity goal remains open.

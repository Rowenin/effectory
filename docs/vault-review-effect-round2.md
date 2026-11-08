# Vaults — Effect contract review, round 2 (draft 1)

Reviewer: Claude, Effect perspective. Inputs: the frozen [draft 1](vault-api-draft.md), [research](vault-research.md), [persistence evidence](vault-persistence-evidence.md), and the round-1 [Effect](vault-design-review-effect-round1.md) and [consumer](vault-design-review-consumer-round1.md) reviews. I approve nothing. This review does not authorize implementation, and user approval is a separate step.

**Conclusion: request changes.** Several of draft 1's choices are sound, and I accept them on their merits, not because the earlier reviews proposed them:

- per-vault service keys;
- declared string codecs;
- `Vault.layer(definition, implementation)`;
- an explicit `LocalStore`;
- SQLite ciphertext with an external key;
- guarded, versioned mutations;
- rejecting values found in typed output and dropping whole text fields when they contain a value.

The most important open question is now answered by a test: **the existing `.exports` facade can carry a lazy provider factory**, so no new Extension contribution kind is needed (§2).

Ten concrete gaps remain (B1–B10). Each is a type hole, an ownership error or a missing contract that would surface during implementation, so none can be left as an implementation detail. Each one has a small correction below. Once they are folded into draft 2, I expect to approve it for presentation without another design round. A focused re-check of the corrected signatures is enough.

Labels: **[tested]** means typechecked or run in a scratch probe against pinned Effect 4.0.5 and the real SDK or host source. **[source]** means read in the current worktree. **[inferred]** means reasoned from source but not run.

Probes are in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/8273da6a-ec19-4b25-bb81-25cf28273ae4/scratchpad/vault-r2/`. That directory holds `vault.ts`, a stand-in carrying the candidate signatures below, plus `consumer.ts`, `registration.ts`, `runtime.ts`, `interrupt.ts` and `archive/`.

- Typechecking used the repository's own `tsconfig` (strict, `exactOptionalPropertyTypes`), TypeScript 7.0.2 and Bun 1.4.3.
- The probes used only synthetic `CANARY-…` and fixture strings.
- I changed no production file, made no commits, started no subagents and used no real credentials.

---

## 1. What draft 1 gets right (kept)

- **One nominal service per vault** (`Credentials.get(k)`, or `yield* Credentials`) and **declared codecs**. [tested] With the declared-codec table, `R` is exactly that one definition, and these all hold:
  - an undeclared key is a type error;
  - each codec's decoded type is kept (`Redacted<number>` for `NumberFromString`, the struct type for `fromJsonString`);
  - a codec with a non-string encoding or with decoding services is rejected;
  - a different vault does not satisfy the requirement;
  - `Task.provide` and `Task.test(...).pipe(Effect.provide(...))` both close `R` to `never`;
  - a custom provider's service and error appear in the Layer's `R` and `E`.
- **`Vault.make` takes only a spec, and the implementation is the second argument of `Vault.layer`.** Contract modules stay importable without provider code, and this is proven through a real archive (§2). `Vault.layer` is an ordinary `Layer.effect`, so it adds no second DI mechanism.
- **Typed, value-free errors in `E`, with `Task.make` unchanged.** Retries stay possible.
- **Correcting the predecessor's F11 is right.** [source] `daemon.ts:36–60` writes `repositoryId` (with the bearer token) to `.effectory/credentials.json`. `backup.ts:53–66` excludes only `daemon.json*`, `daemon.log` and the SQLite owner/shm files, so a backup preserves `repositoryId`. My round-1 F11 was wrong. Draft 1 is still right to keep a separate key ID, so that replacing auth credentials cannot redefine the encryption identity.
- **No claim that publication supervision owns detached fibers.** [source] `publication-lifetime.ts` interrupts only the children it forks itself, through `lifetime.run`.

---

## 2. Installed extension provider factory: feasible without a new contribution kind [tested]

`archive/driver.ts` runs the real pipeline end to end. Every step used checkout source, not a stand-in:

1. **Publish.** A synthetic extension `fixture/vaults` has:
   - a pure `contracts.mts` exporting `secretsManager(options) => (spec) => Effect.flatMap(Effect.promise(() => import("./provider.mts")), m => m.acquire(options, spec))`;
   - a `provider.mts` whose acquisition is wrapped in `Effect.acquireRelease`;
   - a `client.mts` standing in for a bundled third-party SDK;
   - a trivial `extension.mts`.

   Both modules with side effects write a marker file when they are evaluated. The extension was built with the same `Bun.build` options as the existing fixture (`splitting: true`, host peers external) and with `tsc --declaration`.

2. **Archive.** The `archiveFixture` tar was checked with the real **`verifyArchive`**. The archive holds `contracts.mjs`, `extension.mjs`, two `chunk-*.mjs`, and the matching `.d.mts` files. The contract entry imports a shared chunk statically, and that chunk holds `import("./chunk-0gf9qznf.mjs")` for the provider and client.
3. **Install.** The pipeline ran `restoreCache` → `writeBindings` → `trustLock` → `verifyBindings`, and the consumer was then typechecked against the generated `effectory.extensions.ts` and the `.d.mts` files.
   - `Vault.layer(Credentials, Tools.exports.secretsManager({ prefix: "prod/" }))` closes the application to `Application<never, unknown>`.
   - `secretsManager({ prefix: 1 })` and an application without the Layer are both type errors.
4. **Facade import.** Importing the generated facade and _calling_ the factory evaluated **neither provider nor client**: the marker file was empty.
5. **Real catalog.** `revisionCatalogLayer` ran the subprocess **`validateExtensions`** worker, `buildApplication` and `loadApplication`. The marker shows evaluation **only in the daemon process, at Layer build**: `client-eval`, `provider-eval`, `acquire credentials keys=github-token`.
   - No line came from the validation worker's PID. Validation imports the contract entry without evaluating the provider.
   - The registry task returned `prod/credentials/github-token-synthetic-fixture`.
   - Closing the scope logged `release credentials`.
6. **Bundle pinning.** The retained `revisions/<rev>/application.mjs` _contains_ the provider code as an `__esm` lazy initializer and has no relative chunk import. Old runs therefore keep their provider code even if the extension cache changes.
   - Importing that bundle in a **fresh process** evaluated nothing.
7. **Restart.** A second catalog, standing in for a restart, loaded the retained revision, re-acquired the provider and read the value again.

**Conclusion:** `.exports` plus a dynamic import inside the contract entry is enough. No `vaultBackends` field or `fromExtension` helper is needed.

Caveats for draft 2:

- **Validation does not cover the factory.** The worker checks only the contract and implementation exports. A broken lazy chunk shows up at revision Layer build as `RevisionUnavailable`. Draft 2 should state this, and SDK guidance should recommend `Effect.tryPromise` (a typed failure) over `Effect.promise` (a defect) for the import.
- **The probe used extension-local structural types**, because no `Vault` exists in the SDK yet. A real extension writes `import type { Vault } from "@offtree/effectory-sdk"`. The SDK is already external to extension bundles and declarations, so I expect this to work [inferred], but the implementation must repeat the probe with real SDK types.
- **The restart was same-process.** ESM caching hid a second `provider-eval`, and the fresh-process import covered the evaluation question. A real daemon restart test (draft item 6) is still owed.
- **The provider ID appears only at runtime.** It comes from `Backend.providerId` and is absent from the manifest. That is acceptable for `vault list`.

---

## 3. Blockers and smallest corrections

### B1. Same-id definitions collide at runtime [tested]

Effect's runtime service identity is the **key string** (`Context.Service` docs; `Context.js:68–87`). Under draft 1, `Vault.make({ id: "credentials", secrets: A })` and a second `Vault.make({ id: "credentials", secrets: B })` have _different types_ but the _same slot_.

`runtime.ts` provides both Layers:

- `Credentials.get` reached the other definition's handle. My stand-in caught this only because its accessor runs an identity check, which returned `VaultFailure{InvalidDefinition}`.
- **`yield* Credentials` silently returned the other definition's handle.** No check is possible on that path, so a matching key name would decode with the wrong codec and backend.
- `Application.make` can catch this only for _registered_ vaults, because task `R` is erased at runtime.

**Correction:**

- Make the runtime key unique per `Vault.make` call, for example `` `@offtree/effectory-sdk/Vault/${id}#${counter}` ``. Keep `id` as operator metadata.
- `Application.make` rejects two _registered_ definitions with the same `id`.
- Per-module-copy identity is already the rule for extension contracts (`sameContracts` in `extension.ts`), so this adds no new constraint.
- **Do not** use a process-global uniqueness check on `id`. All 128 retained revision bundles live in one process, and each bundle legitimately creates its own `Credentials`.

### B2. Draft 1 contradicts itself on "both paths protected" versus "hand-written handle Layers may serve tasks"

A plain `Layer.succeed(Credentials, { get, getOption })` handle bypasses both registration and decoding on both paths.

**Correction:** make `Handle` nominal. It carries a property keyed by a non-exported `unique symbol`, so only `Vault.layer` can construct one.

- [tested] Under that brand, a hand-written `Layer.succeed(Credentials, {...})` is a type error ("Property '[HandleTypeId]' is missing").
- Fakes go through `Vault.layer(def, Vault.memory(...))` or a custom `Implementation`.
- Remove the draft's sentence that hand-written Layers may serve tasks. A cast remains possible, but it is then outside the contract.

### B3. Exact `Definition`, `Handle`, `Backend`, `Implementation` and registration generics

These typecheck in `vault.ts`, `consumer.ts` and `registration.ts` [tested]:

```ts
type SecretCodec = Schema.Codec<unknown, string, never, never>;
type Secrets = { readonly [name: string]: SecretCodec };

declare const HandleTypeId: unique symbol; // not exported (B2)
interface Handle<Id extends string, S extends Secrets> {
  readonly [HandleTypeId]: { readonly id: Id; readonly secrets: S };
  readonly get: <K extends keyof S & string>(key: K) =>
    Effect.Effect<Redacted.Redacted<S[K]["Type"]>, ReadError>;
  readonly getOption: <K extends keyof S & string>(key: K) =>
    Effect.Effect<Option.Option<Redacted.Redacted<S[K]["Type"]>>, Exclude<ReadError, VaultSecretNotFound>>;
}
interface Definition<Id extends string, S extends Secrets>
  extends Context.Service<Definition<Id, S>, Handle<Id, S>> {
  readonly kind: "Vault";
  readonly id: Id;
  readonly secrets: S;
  readonly get: <K extends keyof S & string>(key: K) =>
    Effect.Effect<Redacted.Redacted<S[K]["Type"]>, ReadError, Definition<Id, S>>;
  readonly getOption: /* same as Handle's, with R = Definition<Id, S> */;
}
function make<const Id extends string, const S extends Secrets>(spec: {
  readonly id: Id; readonly secrets: S; readonly description?: string;
}): Definition<Id, S>;

interface ImplementationSpec { readonly id: string; readonly keys: ReadonlyArray<string> }
interface Backend {
  readonly providerId: string;
  readonly read: (key: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, VaultUnavailable | VaultFailure>;
  readonly list?: Effect.Effect<ReadonlyArray<string>, VaultUnavailable | VaultFailure>;
  readonly admin?: GuardedAdmin; // see B7; all-or-nothing, never bare write/remove
}
interface Implementation<out E = never, out R = never> {
  (spec: ImplementationSpec): Effect.Effect<Backend, E, R | Scope.Scope>;
}
function layer<Id extends string, S extends Secrets, E, R>(
  definition: Definition<Id, S>,
  implementation: Implementation<E, R>
): Layer.Layer<Definition<Id, S>, E, Exclude<R, Scope.Scope>>;
const local: Implementation<never, LocalStore>;
function memory(values: Readonly<Record<string, string>>): Implementation;
```

- **The registration bound must not be `Definition<string, Secrets>`.** `Context.Service` is invariant (`in out`). [tested] `const xs: readonly Definition<string, Secrets>[] = [Credentials]` fails: `'string' is not assignable to '"credentials"'`. Use a structural bound instead, which [tested] keeps each element's exact type in `R`:

  ```ts
  interface Registrable { readonly kind: "Vault"; readonly id: string; readonly key: string }
  Application.make<const T, const X, const V extends readonly Registrable[] = readonly []>(spec: {
    …; readonly vaults?: V;
  }): Application<Requirements<T> | Extension.Requirements<X[number]> | V[number]>;
  ```

  [tested] A registered vault that no task reads is still required, so `Application<never>` fails until it is provided. This is the intended "listed but unprovided fails" behaviour, now enforced at compile time as well.

- **The Registry entry** is `{ definition: Registrable; backend: Backend }`. The build reads it with `Context.get(services, def)` and takes the backend through a handle-internal symbol. Draft 2 should state that this one internal cast happens at the heterogeneous registry, matching the existing `RuntimeTask` erasure in `application.ts`.
- **`Implementation<E, R>`** stays an ordinary function type. [tested] It infers correctly from an installed extension's declared function type, so no wrapper is needed.
- **`Vault.memory` fixture keys are not checked against `S`.** This is a minor ergonomics gap. The smallest fix is an optional overload `memory<S>(values: { readonly [K in keyof S]?: string })` that infers `S` from `layer`'s first argument. It does not block presentation.

### B4. Ownership of the invocation guard: the host owns it, and `Task.execute` only installs it [source]

Draft 1 says ownership "must extend through final encoding" but never names the owner. The source rules out `Task.execute`:

- `definition().execute` runs `Effect.ensuring(lifetime.close)` when the handler returns (`task.ts:369–393`).
- The interpreter then flips `active.value = false` (`interpreter.ts:239–244`).
- _Only after that_ does it encode the domain error (`:251`) and the success value (`:285`). Both encodes run inside the Activity body (`:293`).
- `Task.test` returns the **decoded** value and never encodes again.

**Correction (internal, not public):**

```ts
// packages/core internal module, shared by the interpreter and Task.test
interface InvocationSecrets {
  readonly register: (vault: string, key: string, raw: string, decoded: unknown) =>
    Effect.Effect<void, VaultFailure /* Closed | LimitExceeded */>;
  readonly closeReads: Effect.Effect<void>;                 // the handler has returned
  readonly scanJson: (owned: Schema.Json) => Effect.Effect<Option.Option<{ vault: string; key: string }>>; // cooperative
  readonly scrubText: (text: string) => string;             // sync; for Logger and progress
  readonly clear: Effect.Effect<void>;                      // drop the plaintext needles
}
const CurrentInvocationSecrets: Context.Reference<InvocationSecrets | undefined>; // default: unmanaged
// Task.RuntimeContext gains an internal optional field: secrets?: InvocationSecrets
```

The lifecycle runs in this order:

1. **Acquire.** The interpreter acquires the guard with `Effect.acquireRelease` around _the Activity body_ of each attempt.
2. **Close reads.** It calls `closeReads` where it sets `active.value = false`.
3. **Scan the final encodes.** It calls `scanJson` on the outputs of `:251` and `:285`.
4. **Sanitize defects.** See B5.
5. **Clear.** It calls `clear` in the release step.

`Task.test` creates and clears its own guard the same way. It encodes the returned value and any failure with the task's schemas in order to scan them.

`definition().execute` only _adds_ `CurrentInvocationSecrets` from `runtime.secrets` next to `ArtifactStorage`. Installing the Reference there, innermost, is deliberate:

- `Application.make` wraps `execute` with `Effect.provideContext(services)`, and [source] `provideContext` is `Context.merge` in 4.0.5 (`internal/effect.js:1322`).
- Because the Reference is added inside that merge, a context captured at revision build cannot shadow it [inferred].

One guard per attempt gives isolation between concurrent invocations. Forked fibers inherit the Reference, and their reads fail `Closed` after step 2.

### B5. Defect sanitization must use `uninterruptibleMask` + `Effect.exit`, inside `Activity.make`'s `execute` [tested]

`interrupt.ts` interrupts a fiber whose finalizer dies with a canary. The resulting cause holds both `Interrupt` and `Die`.

| Wrapper | Reasons after | Canary in `Schema.Defect` encoding |
| --- | --- | --- |
| `Effect.catchCause(self, c => failCause(scrub(c)))` | Interrupt, Die | **leaks**: the handler does not get to run on an interrupted fiber |
| `Effect.catchDefect` | Interrupt, Die | **leaks** |
| `uninterruptibleMask(restore => Effect.exit(restore(self)).pipe(flatMap(exit => success, or failCause(scrubReasons(exit.cause)))))` | **Interrupt preserved**, Die replaced | **clean** |

Both wrappers handle a plain `Die` cleanly. A `timeoutOrElse` around the handler dropped the finalizer defect entirely: the result was only `Fail`.

**Correction:**

- Specify the reason-preserving form, which maps each `Cause.isDieReason` whose `Schema.Defect()` encoding matches into a fixed `Error`.
- Apply it to the body passed to `Activity.make` (`interpreter.ts:184–286`), so it runs before Activity's exit is encoded with `Schema.Defect()` (`Activity.js`).
- Activity's own `retryOnInterrupt` already replaces interrupt-bearing causes with a value-free `die` unless the workflow is suspended. The wrapper still has to run first, because the suspended path re-raises the original cause [source].

### B6. The protected-path table is missing exact write points [source]

Add these rows, or fold them into existing ones:

- **`TaskRuntimeError` messages.** `interpreter.ts:249` copies `error.message` into `hostFailure`. Authors can build `TaskRuntimeError` themselves, and `task.ts:tagBoundary` interpolates `String(error)`. Scrub this text, or replace it, before `hostFailure`.
- **JSON publication tags.** Scan them along with the payload in `taskContext.publish` (`interpreter.ts:103`), before `lake.publish`.
- **Logger order.** `task-logger.ts:message()` cuts `Error.message` to 2000 characters _before_ JSON normalization. A value that straddles the cut would leave a prefix behind that no longer matches. Scrub the unsliced text first. Bound that pre-slice scan, for example to 64 KiB: anything longer becomes the omission marker whenever any needle is registered. The Logger callback is synchronous, which matches the persistence-evidence note.
- **Late output.** After `clear`, a detached fiber that inherited the attempt's logger or progress closure must have its field **replaced with a fixed "late output omitted" marker**. It must not be written unscrubbed. This fails closed, with no retained plaintext and no claim of supervising the fiber.
- **Provider-internal logs.** A provider that logs inside `read` does so before the value is registered. Run `backend.read` (and `admin`) under `Effect.provideService(Logger.CurrentLoggers, new Set())`, so provider diagnostics never reach task telemetry. Providers can still write to daemon stderr, which is an existing documented exclusion. [inferred] This needs **a user decision**, because it hides provider debug logs from run telemetry.

### B7. Missing admin types, and `getOption`'s error channel

Draft 1 specifies guarded versions and receipts but gives them no types or errors. `VaultFailure`'s reasons cannot express a precondition failure.

**Correction:** add the following. None of these errors join `Vault.Errors`, because task code never mutates.

```ts
class VaultConflict extends Schema.TaggedError<VaultConflict>()(
  "VaultConflict",
  {
    vault: Schema.String,
    key: Schema.String,
    reason: Schema.Literals(["VersionMismatch", "RequestKeyReused"]),
  }
) {}
interface Status {
  readonly state: "Present" | "Missing" | "Deleted" | "Unknown";
  readonly version: Option.Option<string>;
}
interface Receipt {
  readonly vault: string;
  readonly key: string;
  readonly operation: "Put" | "Delete";
  readonly version: string;
  readonly replayed: boolean;
}
interface GuardedAdmin {
  readonly describe: (
    key: string
  ) => Effect.Effect<Status, VaultUnavailable | VaultFailure>;
  readonly put: (r: {
    key: string;
    value: Redacted.Redacted<string>;
    expectedVersion: string;
    requestKey: string;
  }) => Effect.Effect<Receipt, VaultConflict | VaultUnavailable | VaultFailure>;
  readonly remove: (r: {
    key: string;
    expectedVersion: string;
    requestKey: string;
  }) => Effect.Effect<Receipt, VaultConflict | VaultUnavailable | VaultFailure>;
}
```

- Map `VaultConflict` to `OperationError{Conflict}`.
- `getOption`'s error is `Exclude<ReadError, VaultSecretNotFound>`.
- Move `Closed` out of `VaultUnavailable.reason` and into `VaultFailure.reason`. `VaultUnavailable` is the tag that authors put in `retry.when`, and a closed invocation is not a transient outage.
- Specify how a read behaves against an uninitialized local vault: either a new `VaultUnavailable` reason `NotInitialized`, or `NotFound`. Draft 1 leaves it open.
- The receipt rules in draft 1 (lookup before the version check, the 64-entry window, tombstones v0→v1→v2→v3) are internally consistent. However, **"actor-scoped" has no defined actor** in a single-owner daemon. Either define the actor (for example, the authenticated client token) or drop the term.

### B8. Codec execution: use one asynchronous path, not sync admission plus async reads [tested]

`Schema.decodeUnknownSync` on a codec built with `SchemaGetter.transformEffect` throws `"Sync adapter can only throw schema errors"`, which is not a schema issue. `decodeUnknownEffect` decodes the same codec fine. Admission already runs inside a daemon Effect handler, so draft 1's asymmetry is self-imposed: it would produce a third error class for operators and a codec that tasks can read but operators cannot write.

**Correction:**

- Both `get` and admin `put` use `Schema.decodeUnknownEffect`, bounded by a timeout, with any issue mapped to a value-free `VaultSecretInvalid`.
- Drop the "async decoder cannot accept writes" rule.
- Admission uses the **active** revision's codec, while pinned older runs decode with their own. Draft 2 should state that a value accepted under the active codec can still be `VaultSecretInvalid` for an old run.

### B9. Precise bounds for registering structured secret leaves

"Bounded traversal of decoded values" is under-specified. Traversing a decoded `A` runs user getters and meets class instances, `Redacted`, `Map`s and cycles.

**Correction:** register the following, all counted against the 256-string / 1 MiB budget.

- The raw stored string.
- The decoded value, if it is a top-level `string` that differs from the raw string.
- If the raw string `JSON.parse`s (it is already at most 64 KiB) to an object or array, its **string leaves** only:
  - depth at most 16;
  - at most 256 leaves;
  - property names are not registered, because they are schema metadata and would cause false positives.

For each registered string, also register its `JSON.stringify(s).slice(1, -1)` form when that differs. Exceeding a bound fails the read with `VaultFailure{LimitExceeded}` before the value is exposed. Values that a codec transforms (base64 and similar) stay outside the guarantee, as draft 1 already says.

### B10. `LocalStore`: exact interface and how it is provided

```ts
class LocalStore extends Context.Service<
  LocalStore,
  {
    readonly open: (
      spec: ImplementationSpec
    ) => Effect.Effect<Backend, never, Scope.Scope>;
  }
>()("@offtree/effectory-sdk/Vault/LocalStore") {}
const local: Implementation<never, LocalStore> = (spec) =>
  Effect.flatMap(LocalStore, (s) => s.open(spec));
```

- **`open` is infallible.** Key and metadata state is reported on first `read` or `describe`, which matches "no decryption until requested".
- **One store per daemon.** The daemon acquires a single `LocalStore`, with one SQLite connection and the key cache, in its own scope. `revisions.ts:loadApplication` then provides it as `Layer.succeed(LocalStore, instance)` to every retained revision build.
  - It must not be a Layer that each of up to 128 revision builds would rebuild.
  - Each per-revision `open` handle belongs to that revision's scope.
- **Only one call site changes.** [source] `revisions.ts:82` is the only place that builds application Layers, and its `Layer<Registry, unknown>` cast erases `R`. A missing `LocalStore` would otherwise appear as an opaque "service not found" at revision load.
- **Name the file.** Draft 2 should name the SQLite file: a separate `vaults.sqlite` rather than `state.sqlite`, so the engine's and the vault's single-writer transactions stay independent. If the user prefers `state.sqlite`, say so.

---

## 4. Non-blocking notes

- **Key-init recovery.** "Adopt the same newly created key only when its intended metadata identity is unambiguous" needs a mechanism. The smallest is three steps: insert a `pending_init(vault, keyId)` row; create the key file exclusively (its content embeds `keyId` and `vaultId`); then commit the metadata and delete the pending row. Recovery adopts the key only when a pending row and a key file with the same `keyId` exist and the vault has no ciphertext.
- **`SecretInOutput` is non-retryable.** It is a `TaskRuntimeError`, which becomes a Host failure. Draft 2 should say so.
- **Every retained revision rebuilds application-level provider Layers at startup.** With an extension provider, that means up to 128 client acquisitions. This is round-1 fact F4, restated for remote backends.
- **`backup` also copies the daemon bearer token** in `credentials.json`. This is outside vault scope and is noted only because draft 1 now cites that file.

---

## 5. User decisions draft 2 must surface

1. The per-vault service shape with declared codecs, and **a runtime key unique to each definition object** (B1): two module copies of a contract count as two vaults.
2. **No hand-written handles** (B2): fakes go only through `Vault.layer` and `Vault.memory` or a custom `Implementation`.
3. The `Vault.LocalStore` host requirement, so the documented check becomes `satisfies Application<Vault.LocalStore>`, and a separate `vaults.sqlite` (B10).
4. Application-level reads stay unmanaged and do not rotate.
5. Protection limits:
   - the 8-byte cutoff;
   - no coverage for binary artifacts;
   - raw-JSON leaf registration only (B9);
   - late output omitted (B6);
   - **provider-internal logs suppressed from task telemetry** (B6).
6. Codecs run asynchronously on both paths; active-codec admission versus old-run decoding (B8).
7. An external key with offline export/import.
8. Guarded writes, the 64-receipt window, tombstone versioning, the definition of "actor", and the read behaviour of an uninitialized vault (B7).
9. `reveal` writes raw stdout or a 0600 file, and refuses `--json`.

---

## 6. Evidence summary

| Claim | Status |
| --- | --- |
| Lazy provider factory through `.exports`: real `verifyArchive`, cache, trust, bindings, subprocess `validateExtensions`, `buildApplication`, revision load, read, release, retained-bundle pinning, fresh-process import, same-process restart | **tested** (`archive/driver.ts`) |
| Exact candidate generics: key inference, decoded types, codec constraints, a distinct `R`, `Task.provide`/`Task.test` closure, provider `R`/`E`, rejection of hand-written handles | **tested** (`consumer.ts`, with expected errors checked in `neg/`) |
| `Definition<string, Secrets>` is unusable as a bound; the structural `Registrable` works and keeps registered requirements | **tested** (`registration.ts`) |
| Same-id runtime collision on both paths | **tested** (`runtime.ts`) |
| Sync decode fails on an async codec; Effect decode works | **tested** |
| `catchCause`/`catchDefect` leak under interruption; `uninterruptibleMask` + `exit` scrubs and keeps `Interrupt` | **tested** (`interrupt.ts`) |
| `Task.test` passes an echoed secret today (no guard) | **tested** |
| The `Task.execute` close precedes the interpreter's final encodes; `provideContext` merges; only `revisions.ts:82` builds application Layers; F11 correction | **source** |
| Installing the Reference innermost cannot be shadowed by Application capture; detached fibers inherit the logger; real-SDK `import type` in extension declarations; daemon-restart behaviour | **inferred** |
| Real daemon canary sweep, SQLite and key crash tests, matching benchmarks under load | **not done** (implementation gates, items 2–7 in the draft) |

No repository checks were run, because no production file changed. The only file written in the checkout is this review.

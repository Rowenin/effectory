# Vaults — Effect contract review, round 3 (draft 2)

Reviewer: Claude, Effect perspective. This is a focused re-review, not a redesign. It covers the frozen [draft 2](vault-api-draft.md) and the [resolution notes](vault-contract-resolution.md), checked against my [round-2 review](vault-review-effect-round2.md) (B1–B10) and the current source. **This approval is from a reviewer. It is not user approval, and it does not authorize implementation.**

**Conclusion: conditionally approved for presentation.** Draft 2 resolves B1–B10. I tested the deliberate deviation, which tracks secrets through Context alone with no `RuntimeContext.secrets` bridge, using the real SDK `Task` and `Application` on pinned Effect 4.0.5. It works, but only after two small private corrections:

- **C1.** Split the single three-state Reference into two keys. This removes the `Application.make` omission obligation and a fail-closed gap.
- **C2.** A handle built under host ownership never serves an unmanaged read. This closes an _unscanned leak_, which I tested.

A third correction, C3, wraps the codec decode in `Effect.suspend`. That also has a tested leak. C1–C3 are internal wording changes with no new public API, so they can go into the draft without another review round. C4 lists minor items that can be fixed in the same edit.

Labels used throughout:

- **[tested]**: run or typechecked in a scratch probe against pinned `effect@4.0.5`, Bun 1.4.3 and TypeScript 7.0.2 under the repository `tsconfig`. Where a probe used the real SDK `Task.make`, `Task.provide`, `Task.test` or `Application.make`, the finding names it.
- **[source]**: read in the current worktree.
- **[inferred]**: reasoned but not run.

Probes are in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/1a757a95-b169-427d-8354-c24b5c00160c/scratchpad/vault-r3/`:

| Probe | What it covers |
| --- | --- |
| `ownership.ts` | The draft's single Reference, real `Application.make`, and a copy of it with the omission applied |
| `twokey.ts` | C1, run against **unmodified** `Application.make` |
| `escape.ts` | C2 |
| `codec.ts` | C3 |
| `vault.ts`, `consumer.ts`, `registration.ts`, `neg/` | The draft-2 signatures |

Everything under "stand-in" in those files does not exist in the SDK: the ownership References, the tracker, the vault handle and Layer, and the interpreter wrapper. All values are synthetic `CANARY-…` strings. I changed no production files or drafts, made no commits, started no subagents and used no credentials. The only file written in the checkout is this review.

---

## 1. Round-2 B1–B10 against draft 2

| Item | Status in draft 2 | Residual |
| --- | --- | --- |
| B1 same-ID collision | **Resolved.** Each `Vault.make` gets a unique runtime key, registered duplicate IDs are rejected, and retained bundles may each hold their own instance (draft §Authoring, last paragraph). | C4a: the uniqueness nonce must not be a module-local counter. |
| B2 hand-written handles | **Resolved.** The handle is branded, and only `Vault.layer` constructs one. [tested] `Layer.succeed(Credentials, {get, getOption})` fails with "Property '[HandleTypeId]' is missing". | None. |
| B3 exact generics | **Resolved** for `Handle`, `Definition`, `make`, `Backend`, `Implementation`, `layer`, `memory`, `LocalStore` and `local`. [tested] Under the draft-2 shapes these hold: key inference, decoded `Redacted<number>`, rejection of undeclared keys, non-string codecs and codecs with services, a distinct `R`, closure through `Task.provide` and `Task.test`, provider `R`/`E`, and the exact example `satisfies Application.Application<Vault.LocalStore>`. The invariant `Definition<string, Secrets>[]` bound still fails, and the structural `Registrable` bound still works and keeps a registered-but-unused vault in `R`. | C4c: `Application.make`'s new generic appears only in prose. |
| B4 tracker ownership | **Replaced by the deliberate Context-only alternative** (§2). | C1 and C2. |
| B5 interruption-aware sanitation | **Resolved.** The draft specifies `uninterruptibleMask` + `Effect.exit(restore(body))`, maps only matching Die reasons and preserves Interrupt. Re-tested together with tracker clearing (§3). | C4d: use the `acquireUseRelease` form. |
| B6 missing write points | **Resolved.** The table covers `TaskRuntimeError` text, publication key and tags, pre-truncation text, late output and suppressed provider telemetry. | None. |
| B7 admin types, `getOption`, `Closed` | **Resolved differently and acceptably.** The public `Backend` is read-only, mutation is a private host adapter, and conflicts use the existing `OperationError{Conflict}`. [tested] `getOption`'s error is `Exclude<ReadError, VaultSecretNotFound>`. `Closed`, `Corrupt` and `KeyMismatch` now live under `VaultFailure`. `NotInitialized` is defined. "Actor" is replaced by `(vault, key, requestKey)`. | None. |
| B8 one async codec path | **Resolved.** Reads and `put` both use `decodeUnknownEffect` with a five-second bound. | C3: eager getter throw; C4e: `NumberFromString` example. |
| B9 registration bounds | **Resolved** as specified. | None. |
| B10 `LocalStore` | **Resolved.** `open: (spec) => Effect<Backend, never, Scope>`, one instance per daemon, a dedicated `vaults.sqlite`, and each open handle belongs to its revision scope. | C4b: how the built-in backend is identified. |

---

## 2. Context-only tracker handoff: does it propagate?

### 2.1 Why the draft needs the omission [tested, real `Application.make`]

`Application.make` captures `Effect.context()` at revision build. It then wraps every `task.execute` in `Effect.provideContext(services)` [source, `application.ts:103–121`]. In 4.0.5, `provideContext` is `Context.merge(fiberContext, provided)`, and the provided keys win [source, `internal/effect.js:1322–1325`].

`ownership.ts` builds an unmodified `Application.make` revision under the stand-in `RevisionBuild` state. The interpreter stand-in then provides `Invocation` around `task.execute`. **Every read inside the task saw `RevisionBuild` and failed.** This happened for direct handler reads and also for acquisition inside a `Task.provide` Layer, because the captured state shadows the interpreter's. The draft is therefore right that a single Reference _requires_ `Application.make` to omit it.

### 2.2 The draft's design, with the omission applied [tested, stand-in copy of `application.ts:103–121` plus `Context.omit`]

| Path | Result |
| --- | --- |
| Handler read | `Invocation:open`, 1 needle at final encoding |
| `Task.provide` Layer acquisition read | `Invocation:open` |
| Task-local finalizer read | `Invocation:open`. `Effect.addFinalizer` captures context at registration [source, `internal/effect.js:1835`], and `Task.provide`'s scope closes inside `execute`, before the interpreter's close. |
| Application-level client that captured the **handle** and calls it from the task | `Invocation:open`. The handle must read the Reference from the calling fiber, never at construction. |
| Application-level client that captured **`Effect.context()`** at build and re-provides it around its effects | **`RevisionBuild`, so the read is rejected.** This is a common Layer pattern. It fails closed, but it is a real handoff gap that the draft's sentence "calls from inside tasks remain managed" does not admit. |
| `forkDetach` that reads after the handler returns | Fails `Closed`. |

### 2.3 C1: split into two private References (required; no public change)

Use two References instead of one three-state Reference:

```ts
// internal; both keys stable strings, no exports
const RevisionBuild: Context.Reference<boolean>;            // default false
const Invocation: Context.Reference<Tracker | undefined>;   // default undefined
// read precedence: Invocation present → managed;
//                  else RevisionBuild → VaultFailure{Unmanaged};
//                  else unmanaged
```

The interpreter and `Task.test` provide `Invocation` per attempt. The host builds every revision with `RevisionBuild = true` **and** `Invocation = undefined`, so that no lazily triggered build can inherit an attempt.

Why this works: `Invocation` is never present at revision build, so no captured context, whether `Application.make`'s or a user Layer's, can contain it. `Context.merge` therefore always keeps the attempt's tracker.

[tested, `twokey.ts`, **unmodified** `Application.make`]:

- The captured-context client read is managed (`captured-ok`, tracker open).
- The `Task.provide` acquisition read is managed.
- A build-time read is rejected.
- Real `Task.test(...).pipe(provideService(Invocation, t), Effect.provide(VaultLayer))` registered the needle. The handle reads at call time, so it makes no difference whether `Task.test`'s internal tracker sits inside or outside the user's `Effect.provide`.

Draft changes:

- Replace "Unmanaged/RevisionBuild/Invocation states" and "Application.make must omit this private control Reference" with the precedence rule above.
- Keep the omission only if the user prefers one key. In that case, document that re-providing a build-captured context rejects vault reads.

### 2.4 C2: handles built under host ownership never serve unmanaged reads (required)

[tested, `escape.ts`, real `Task.make` + `Application.make`] A task does `Effect.promise(() => Effect.runPromise(handle.get(...)))`. A bridging adapter or a callback-style library does exactly this by accident. The new root fiber has an empty context, so the read is `Unmanaged`, **succeeds and registers nothing**. The task then returned the canary, and the tracker had 0 needles, so final-output scanning would pass it. Under C1's precedence rule the read is not rejected, because `RevisionBuild` is false in a fresh root. **This is an unscanned leak inside the invocation's dynamic extent**, not the stated exclusion for "values read outside an invocation".

**Correction:**

- When `Vault.layer` builds a handle, it records `managed = RevisionBuild || Invocation !== undefined`.
- A managed handle with no `Invocation` in the calling fiber fails `VaultFailure{Unmanaged}`.

[tested] With this rule the same probe returned `failed:Unmanaged`.

- Handles built outside host ownership remain unmanaged: standalone Effects, the user's outer `Effect.provide` in tests, and module-top-level runtimes. Draft 2 should state that exclusion in one sentence.
- A `ManagedRuntime` created inside a task over a task-local `Vault.layer` also becomes managed, so its reads from new roots are rejected [inferred from the same rule].

### 2.5 Remaining unavoidable gaps (state them; do not fix them)

- **Captured `Invocation` reused across attempts.** A module-level cache of a context captured inside one attempt, re-provided in a later attempt, shadows the new tracker. It fails `Closed` [inferred]. This fails closed, so it is acceptable.
- **Detached fibers.** Reads after close fail `Closed` [tested]. Logs and progress emitted after clear depend on the logger and progress closures holding the attempt tracker directly (C4f).
- **Synchronous blocking.** Synchronous JavaScript inside a decoder or finalizer cannot be preempted by the timeout or by interruption. The draft already says this.
- **Unmanaged handles.** A handle built outside host ownership (§2.4) is unmanaged everywhere. That is the documented standalone behaviour.

---

## 3. Exit sanitation, clear ordering and scope [tested, `twokey.ts`]

The attempt stand-in is:

```text
acquireUseRelease(newTracker,
  t => uninterruptibleMask(restore =>
         exit(restore(execute.ensuring(close).provide(Invocation, t))) → sanitize),
  t => clear)
```

I ran it against a real `Task.make` handler that reads, registers a finalizer dying with the secret, and blocks. An external `Fiber.interrupt` produced:

- a raw cause of `Interrupt` plus `Die("boom CANARY…")`;
- `sanitize` running with needles = 1;
- final reasons `Interrupt, Die`, with **no canary** in the pretty cause;
- `clear` logged **after** `sanitize`.

On success, the final encoding saw the needles before `clear` ran.

`acquireUseRelease` needs no `Scope`, so it adds no new scope to the Activity body. Round 2's `acquireRelease`-around-body wording would need `Effect.scoped`; prefer `acquireUseRelease` (C4d).

Not re-run: Activity's own `Schema.Defect` encoding and its `retryOnInterrupt` path. Round 2's [source] reading stands: the wrapper must sit inside `Activity.make({ execute })`, around the whole body at `interpreter.ts:200–286`, including the success encode at `:285`.

---

## 4. Codec execution and error mapping [tested, `codec.ts`]

| Codec | Result |
| --- | --- |
| Sync adapter on an async codec | Throws "Sync adapter can only throw schema errors". This confirms B8. |
| `transformEffect` (async) via `decodeUnknownEffect` | Decodes. |
| Invalid value (`NonEmptyString` on `""`, `FiniteFromString` on text) | `Fail` → `InvalidValue`, value-free. |
| 10-second decoder under a bounded `timeoutOption` | `DecodeTimedOut`. |
| External interrupt during decode | Remains interruption. |
| **Getter that throws, called as `decodeUnknownEffect(codec)(raw)`** | **Throws eagerly, while the Effect is being constructed.** The defect escapes the mapping and its message contains the canary. |

### C3: wrap the decode in `Effect.suspend` (required wording)

The fix is `Effect.suspend(() => Schema.decodeUnknownEffect(codec)(raw))`. [tested] With that wrapper, the throwing getter maps to `DecoderFailed` with no leak. Specify this for both reads and `put`.

Specify the mapping order as well:

1. Run under `exit`.
2. Interrupt → re-raise as interruption, dropping any sibling Die reasons.
3. Fail → `InvalidValue`.
4. Die → `DecoderFailed`.
5. Timeout → `DecodeTimedOut`.

Provider initialization and network errors remain ordinary Layer `E` [tested, typed in round 2 and unchanged]. A provider whose acquisition reads another vault is now rejected at build (`VaultFailure{Unmanaged}` in that Layer's error). Consumers who planned to store a remote provider's bootstrap credential in a local vault must read it lazily inside `read`. That read is then managed and registered. One sentence in the draft would prevent surprise.

---

## 5. C4: minor items to fix in the same edit

### a. Unique-key nonce

Draft 2 says a duplicated SDK or module copy "does not supply the original service". That is true only if the uniqueness component is not a per-module counter: two SDK copies would both mint `credentials#1`.

- Today, revision and extension bundles externalize `effect` and `@offtree/effectory-sdk` [source, `application-bundle.ts:52–56`; round 2 §2], so one counter per process would work.
- Specify a random nonce (`crypto.randomUUID()`) or a `Symbol.for`-registered counter anyway. [tested] The random-key stand-in typechecks and serves tasks.
- Runtime keys must never be persisted. Operator data uses `id`.
- The two _private_ References should keep stable, unversioned key strings, so a stray SDK copy still sees the host's tracker. Read the tracker structurally, never with `instanceof`.

### b. Built-in backend identity

The private admin adapter and the reserved `effectory/` provider prefix should be checked by **object identity**: a `WeakSet` of backends minted by the host's own `LocalStore` instance. Neither of these works:

- `providerId`, which any provider can claim;
- a symbol-keyed property, because object spread copies own enumerable symbols, so a wrapping provider would inherit the property [inferred from JavaScript semantics].

A non-built-in backend that claims `effectory/` fails `Vault.layer` with `InvalidDefinition`, an ordinary Layer error.

### c. Exact `Application.make` signature

Show it, as tested in round 2 `registration.ts` and re-run here:

```ts
interface Registrable { readonly kind: "Vault"; readonly id: string; readonly key: string }
function make<const T extends readonly RegisteredTask[] = readonly [],
              const X extends readonly Extension.Use[] = readonly [],
              const V extends readonly Registrable[] = readonly []>(spec: {
  …existing fields; readonly vaults?: V;
}): Application<Requirements<T> | Extension.Requirements<X[number]> | V[number]>;
```

### d. Wrapper form

Say `acquireUseRelease` for the attempt tracker, not `acquireRelease`.

### e. `NumberFromString` example

[tested] `Schema.NumberFromString` accepts any string and decodes non-numeric text to `NaN`, which JSON-encodes as `null`. Use `Schema.FiniteFromString` in the codec examples, or note this.

### f. Logger and progress hold the tracker directly

The per-attempt `taskLogger` and progress closures should capture the attempt tracker directly instead of resolving it from the fiber. The interpreter already builds both per attempt [source, `interpreter.ts:279–283`]. That way late or detached output follows the clear/omit rule regardless of which context a fiber carries [inferred].

### g. Extension-declared vaults and copies

If an extension's internal task requires a vault from its own contract module, and the application provides the facade's copy, the two must be the same module instance. Within one bundled `application.mjs` they are [inferred from round 2 §2: one bundle and a shared chunk].

Otherwise the failure appears only at read time, as a missing-service defect, because `R` is erased. The draft should say that a missing vault service surfaces as a defect naming the vault `id`, and that registering the vault turns this into a construction-time check. No new API is needed.

---

## 6. Approval scope

I approve draft 2 for **presentation to the user** once C1–C3 are folded into its "Internal ownership" and "Types, codecs and errors" sections and the C4 notes are applied. Another review round is not needed for those edits. A parent check that the wording matches this review is enough.

The extension feasibility from round 2 stands. No new contradiction required re-running the archive pipeline.

User decisions are unchanged from the draft's list. C2 adds one sentence to the protection-limits decision: handles built outside host ownership are unmanaged.

Implementation gates (draft item list) must add:

- C1 and C2 as real-SDK tests: a build-captured-context client, a `runPromise` escape, task-local finalizer reads, and revision builds with `Invocation` cleared;
- C3's eager-throw decoder.

| Claim | Status |
| --- | --- |
| A single Reference without omission is shadowed by `Application.make`'s captured services | **tested** (real `Application.make`) |
| With omission, the handler, task-local Layer and finalizer read correctly; a build-captured-context client is rejected; a detached read fails `Closed` | **tested** (stand-in copy of `application.ts:103–121`) |
| Two-key precedence works with unmodified `Application.make`, including the captured-context client, the build-time rejection and real `Task.test` | **tested** |
| `runPromise` escape is an unscanned leak; a pinned managed handle closes it | **tested** |
| Interrupt + finalizer Die sanitized, Interrupt kept, clear after sanitize, no Scope | **tested** |
| Eager throw from `decodeUnknownEffect`; `suspend` fixes it; timeout, interrupt and invalid-value mapping; `NumberFromString` NaN | **tested** |
| Draft-2 signatures, the brand, the `LocalStore` export check, `Registrable`, the same-literal twin indistinguishable by type | **tested** |
| `provideContext` merge order, `addFinalizer` context capture, SDK externalized in bundles, interpreter ordering | **source** |
| Symbol-spread inheritance, logger closure, cross-attempt captured `Invocation`, extension module identity in a bundle, Activity serialization placement | **inferred** |

No repository checks were run, because no production file changed.

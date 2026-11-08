# Vault contract resolution notes

Status: parent resolution of both round-2 reviews. [Draft 2](vault-api-draft.md) incorporates the choices and both round-3 corrections below. It is ready for user approval. **Not user-approved; no implementation authorized.** Earlier exploratory sections record the reasoning, not additional unresolved alternatives in draft 2.

## Draft 2 resolutions

Consumer round 3 conditionally approves presentation. Its C1–C6 are now incorporated: external resolved key/output paths and honest whole-tree backup wording; key-ID filenames and Pending-init recovery; CAS before pruning with receipt removal; operation-time database opening; separate WAL/page limits and backup SHM exclusion; and an admin OperationError mapping. Smaller corrections cover newline notices, terminal input refusal, revision-aware retry hints, orphan administration, and token reuse after whole-store restore. Effect round 3 also conditionally approves presentation; its corrections are now incorporated. These are draft changes only.

- Use a unique runtime service key for each definition, reject duplicate registered IDs, and require branded handles built by Vault.layer. Application registration uses a structural bound rather than an invariant heterogeneous Definition type.
- Keep the public Backend read-only. Expose LocalStore.open as the Effect review proposed, with one daemon-owned instance and a dedicated vaults.sqlite. Built-in mutation remains private to the host; a custom read provider does not acquire administration privileges by naming itself local.
- Reject reads during host revision construction. Local provider acquisition remains independent of initialization/key state. Arbitrary extension Layer failures still require repairing their bootstrap configuration; the draft makes no universal startup guarantee.
- Keep tracking through the interpreter's final encoding and interruption-aware Exit sanitation. The final alternative to a RuntimeContext bridge is two private References: a build marker and an invocation tracker, with tracker precedence. Revision construction removes the invocation entry at its boundary; Application captures context normally. Host-owned handles reject untracked fresh-root reads. The reviewer probed propagation through real Task/Application and stand-in vault internals.
- Cover publication metadata, TaskRuntimeError messages, pre-truncation text and late logs; suppress provider Effect telemetry before registration. Bound registration to raw strings, raw JSON string leaves and a different decoded top-level string, without traversing arbitrary decoded objects.
- Use asynchronous bounded decoding on both reads and puts. Keep permanent errors separate from retryable unavailability and specify administrative receipts/conflicts independently of task errors.
- Retain per-vault external root keys, with explicit escrow and offline destructive reset. This avoids resetting one lost key stranding other vaults, at the cost of multiple escrow files.
- Use the corrected store-wide counter and global absence fence described below. Bound ciphertext, stored identities/keys and receipts, with physical SQLite growth as a separate implementation proof.
- Extension factories now have end-to-end feasibility evidence from the Effect review through archive verification, facade generation, validation, bundling and revision loading. Real SDK types, CLI installation and an actual daemon restart remain implementation gates.

## Accepted corrections to carry into the next draft

- Decode administrative put values asynchronously before the SQLite transaction. Compare-and-set and receipt insertion remain atomic inside it. No need for a read/write asymmetry that accepts an async codec only on reads.
- Match managed log/error text before truncating it. Add publication key and tags to guarded persistence, for both the legacy publisher and ArtifactStorage. Binary content remains a separately stated exclusion.
- Show real imports, installation with `extension add github:OWNER/REPO@TAG --as NAME --trust`, source-edit activation by daemon restart, and staged add-then-edit ordering. Replace the unproven word "tested" with an explicit proof gate until the installed archive/facade path is demonstrated.
- Route online administration through a chosen retained revision, with optional `--revision` and the resolved revision in replies. This keeps an old provider administrable during a cutover. Offline local-store repair/key commands do not load a revision or remote provider.
- Make the public backend read-only in this slice, with optional metadata inspection/listing. Local mutation is a host adapter, not an unproven remote exactly-once contract. A read-only extension backend remains required for the slice.
- Keep memory fixtures read-only to administration; an accepted put must not disappear on restart because the application happened to select a test Layer.
- Move permanent corruption, wrong-key and closed-owner errors out of the top-level retryable unavailable error. All errors remain value-free.
- State Task.test's coverage precisely: it can cover its success/error encoding, publications and progress; real-daemon tests cover logger integration, Activity defects and the interpreter's final encoding.
- Require valid UTF-8 and bounded file/stdin reads. Refuse TTY stdin without an implemented hidden prompt. Reveal returns stored bytes rather than forcing them through the latest codec, so an invalid value remains recoverable.

## Storage and reset need more than the suggested floor rule

The consumer review correctly identifies permanent growth in per-key receipts and removed-key/vault state. Its suggested floor algorithm needs correction before adopting it.

Two counterexamples:

1. A key is created at v1, deleted at v2, and a caller prepares a recreation with expected v2. Reset deletes the tombstone and sets the absent floor to the **highest already issued** version, also v2. That stale recreation still succeeds after reset. A reset must issue a strictly new fence, not reuse a prior version.
2. Raising a vault-wide floor above the version of another still-present key must not invalidate that key's legitimate update. The rule "reject every request below the floor" would permanently reject its current version. Compare against the specific current state; the absence floor applies only when no row remains.

A synthetic in-memory probe confirmed the first reuse and a corrected candidate: one persistent monotonic store counter issues all local versions; forgetting/resetting state advances the counter again and sets a global absent-key token to that new value. Existing present/deleted rows keep their own tokens. The absent token only supplies the state of a key with no retained row. The CAS compares exact current tokens, not ordering against the floor.

Probe sequence: create A v1, create B v2, delete B v3; forgetting B advances absence to v4. A delayed B recreation expecting v3 conflicts; A still updates with expected v1, receiving v5. A subsequent fresh B create must use the observed absent token v4. This is feasibility evidence, not an approved public version contract or a persistence/crash test.

Using a store-wide counter and absence token also allows truly forgotten vault IDs without a permanent per-vault floor row. Advancing the absence token changes preconditions for other absent keys, which may cause a safe Conflict; present-key tokens remain valid. All state-forgetting and fence updates must be one transaction. User-facing versions stay opaque strings; `0` is only the initial store's absence token, never a timeless promise for a new key name. The next draft and re-review must make this consequence explicit.

Proposed bounded storage should count ciphertext, receipts and retained records across the whole store, permit deletion/reset at the write limit, and evict receipts without disabling emergency operations. Bounds do not guarantee builtin backup forever: the shared SQLite file and unrelated run history still have their own growth. SQLite deletion also does not shrink its file automatically. A data budget cannot be advertised as a physical file-size or backup guarantee.

## Startup and repair remain a design decision

Source confirms that startup builds every retained revision and one Layer failure aborts it. First-party local/memory provider construction must not touch key material or fail because a vault is uninitialized. Actual reads report those states.

Rejecting vault reads during host revision construction can prevent such a bad revision from ever becoming retained, while allowing standalone Effects and task-local Layers. But declaring that arbitrary extension acquisition can never fail is not something Effectory can enforce by documentation. Provider bootstrap Config and resource acquisition ordinarily have a typed error channel. The next resolution must distinguish a recommended provider contract from an enforced startup guarantee, and explain recovery from missing external bootstrap configuration without inventing a hidden alternate DI system.

An offline local repair path is an alternative to rejecting build-time reads; it would need explicit semantics for bypassing revision codecs, and cannot repair an arbitrary remote provider. Do not silently add it or claim that key import/reset alone can recreate a deleted credential. The parallel Effect review is expected to help settle this choice.

## Key ownership and backup

External key material, no silent regeneration and explicit escrow remain sound. Per-vault versus per-store root key is still a user-visible choice. A single store key reduces escrow files but makes losing it affect every local vault; reset/reinitialization semantics must cover that. A per-vault reset must not accidentally strand unrelated ciphertext under a replaced store key.

Deletion/rotation does not revoke older encrypted backups. A version token and authenticated envelope also cannot detect restoration of an entire older valid database snapshot. Keep both limits explicit regardless of the chosen storage/key model.

## Effect round-3 corrections and parent check

- C1: two private References replace the three-state Reference. At revision build, remove the invocation entry entirely with Context.omit through Effect.updateContext, not provideService(undefined). The review says “Invocation = undefined” while its successful probe leaves the key absent. A parent scratch probe against pinned Effect confirmed that explicitly providing undefined is captured and shadows a future invocation; removing the key preserves the reference default and later tracker. This is a private implementation clarification of the reviewed requirement that no invocation entry be captured during build.
- C2: handles created under host ownership remember it and refuse untracked calls, including fresh Effect.runPromise roots. Standalone-created handles remain usable outside the host, with unmanaged reads explicitly excluded from protection.
- C3: both read and put wrap decoder construction in Effect.suspend, inspect the Exit and map decoder failures without values, preserving interruption.
- C4: random runtime definition keys; host backend identity via WeakSet; exact Application.make generic; acquireUseRelease tracker lifetime; FiniteFromString examples; direct tracker capture for logger/progress; missing-service behavior and canonical extension definitions.
- The backend identity check runs after the provider factory returns. Its failure uses the existing DefinitionError, explicitly included in Vault.layer’s Layer error union, rather than silently claiming provider E covers that validation error. This matches Application’s existing default error and its documented satisfies check.

Parent probe: /tmp/effectory-vault-reference-absence.ts. It checks only Effect context merging/defaults, not production vault code. Production code remains unchanged; actual Activity encoding, daemon ownership, crypto/recovery and installed SDK extension integration remain implementation gates.

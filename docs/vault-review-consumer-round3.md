# Vaults: consumer contract review, round 3

Reviewer: Claude (consumer, operator and API-clarity view). Subject: the frozen [draft 2](vault-api-draft.md) and the [resolution notes](vault-contract-resolution.md), checked against my [round 2](vault-review-consumer-round2.md), the [Effect round 2](vault-review-effect-round2.md) and the current source.

Status: **review only. A reviewer's approval is not user approval.** Nothing is implemented. No production file and no draft was edited, and nothing was committed. All probes ran outside the checkout on synthetic data. No credentials were used.

**Verdict: conditionally ready for presentation to the user.** Draft 2 closes all eight round-2 blockers. It also fixes my B4 floor algorithm correctly: the store-wide counter with an absence token that is strictly advanced does not reintroduce the "highest-issued floor" bug, and I reproduced that below. Six small corrections (C1–C6) should go in before the user sees the contract. Each is wording or a one-line rule, not a new API family. Two of them correct claims that are currently untrue: the example's escrow file ends up in the backup (C1), and the startup-infallibility wording leaves out the store file itself (C4). The rest (§4) can be settled during implementation or folded into proof gates. I found no new user decision. §6 lists two consequences the presentation should spell out.

Evidence labels:

- **[tested]**: run on 2026-11-05 in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/ef07ed76-f772-410a-be58-c41fa364100e/scratchpad/r3/`, with Bun 1.4.3 and its bundled SQLite 3.51.0 on macOS. `fence.ts` is a plain-TypeScript model of the draft's token rules. `pages.ts` exercises a real WAL database file with random bytes standing in for ciphertext, and a cap scaled down to 8 MiB. These test models, not an implementation.
- **[source]**: read in this worktree at the cited location.
- **[inferred]**: reasoned from the draft or source, not run.

---

## 1. Round-2 blockers re-checked against draft 2

| # | Round-2 blocker | Draft 2 | Status |
| --- | --- | --- | --- |
| B1 | Daemon-start deadlock | Reads during host revision build fail `Unmanaged` (draft:190). `LocalStore.open` is typed `never` and does no key or init I/O (draft:173, 182). Draft:192 states honestly that third-party Layers can still fail. Offline key and reset commands bypass application loading (draft:192, 268). | **Resolved**, with two wording gaps: the store file's own open/migration (C4) and how long old bootstrap config must be kept (§6.1). |
| B2 | Vault data can break backup | A separate `vaults.sqlite`, 16 MiB of ciphertext, 128 identities, 256 records per vault, 8 receipts per key and 4,096 per store, and a 64 MiB page cap with churn proof (draft:236–244). The 1 GiB total is stated honestly as not covered. | **Resolved**, apart from WAL/shm backup details (C5). |
| B3 | Orphaned keys, orphaned vaults and lost keys | `describe` shows stored-but-undeclared keys, which can be deleted or revealed (draft:290). Offline `vault reset <vault> --discard` works on orphaned vaults and lost keys (draft:264). | **Resolved.** Init's Pending state needs one more rule (C2). |
| B4 | Versions are safe only while tombstones live forever | A store-wide counter plus a global absence token, advanced strictly on reset and prune. Live rows keep their own tokens. CAS compares exact tokens (draft:246–250). | **Resolved**, and it corrects my floor rule. Confirmed in §2. The order of pruning inside a put needs one rule (C3). |
| B5 | Old provider cannot be administered after a switch | Optional `--revision` on online commands, with the resolved revision in every reply (draft:268, 296). | **Resolved.** The uncertain-delivery hint needs the revision (§4.3). |
| B6 | Missing signatures | `Backend`, `KeyState`, `Implementation`, `layer`, `memory`, `LocalStore` and `local` are given (draft:148–176). The reply shape is at draft:296. "Actor" is dropped (draft:294). | **Resolved.** Admin errors need a mapping to `OperationError` codes (C6). |
| B7 | "Tested" extension claim | Draft:322–324 credit the Effect reviewer's actual runs and list their limits. Gate 6 remains. | **Resolved.** I did not re-run them. Nothing here claims an implementation was tested. |
| B8 | Missed publication metadata; truncation | Publication key and tags, matching before truncation, "verbatim occurrence", and late output are all covered (draft:206–216). | **Resolved.** `task-logger.ts:11–12` still truncates at 2,000 and 200 characters [source], so the "match before truncating" rule is load-bearing for the implementation. |

---

## 2. Version fence: probe results

[tested] `fence.ts` applies the draft's rules: one counter; reset and prune do `counter += 1; absence = counter` and then forget rows; CAS compares the exact current token; receipts are checked first.

| Scenario | Result | Matches draft |
| --- | --- | --- |
| Draft:250 example: A v1, B v2, delete B v3, forget B | absence = 4. A stale recreate of B expecting 3 → Conflict. The original create of B (expecting 0) retried after its receipt is gone → Conflict. A updates with expected 1 → v5. A fresh B with expected 4 → v6. | Yes |
| The old highest-issued floor | The floor would be 2 after create v1 and delete v2, so a stale recreate expecting 2 would pass. | The draft avoids this. Not reintroduced. |
| Offline reset, then exact retry of a pre-reset create | Conflict (`expected 0; current Absent:2`). | Yes: reset fences cleared receipts |
| Reset of vault Y while a create in vault X was prepared from a pre-reset `describe` | Conflict, then success after describing again. | Yes: a safe cross-vault Conflict |
| **Online** tombstone prune in Y racing a create prepared in X | Conflict. | Yes. Note: resets are offline, so prune is the only _online_ source of cross-vault absence churn. |
| Receipt evicted store-wide, then exact retry | Conflict against `Present:1`. No double apply. | Yes |
| Delete retried after its own tombstone was pruned | Conflict against the new absence token. | Yes, provided pruning also drops that key's receipts |
| **A put into a full vault that triggers pruning** | Prune _before_ CAS: the put conflicts against the absence token it has just advanced (`expected 0; current Absent:5`). Prune _after_ CAS: success at v6. | **Unspecified in the draft. See C3.** |

The prune-before-CAS ordering is worse than one Conflict. In a real transaction the prune rolls back together with the failed CAS. Every retry then re-reads the old absence token and conflicts again, so creates into a full vault are livelocked [inferred from the tested ordering]. The draft never says the order, so this is a contract rule, not only an implementation detail.

One claim needs narrowing: "Tokens are never reused, including after reset" (draft:248) holds within one store history. Draft:250 already admits that restoring an older snapshot rewinds the counter. That means tokens issued after the snapshot _will_ be issued again, so a request prepared against the newer state could match an unrelated reissued token [inferred]. Say "never reused within one store history; after a restore, describe again before any write". No epoch mechanism is needed.

---

## 3. Corrections before presentation

### C1. The walkthrough puts the escrow key and plaintext inputs into the backup

[source] `backup.ts:108–160` inventories the **whole repository tree**. It excludes only `node_modules`, `.git`, daemon files and the `state.sqlite` owner/shm files (`backup.ts:53–67`). Draft:284–285 run `vault key export credentials --output recovery.key` from the repository, then `effectory backup ../snapshot`. That snapshot contains both the ciphertext and its raw root key, which is exactly the separation draft:262 promises. The same applies to `--file token.txt` and `rotated.txt` at draft:277–279, and to `reveal --output`. Git may also commit these files. Likewise, a key directory set with `EFFECTORY_KEY_DIR` inside the repository is copied "by location".

Smallest fix:

- Use paths outside the repository in the examples (`--output ~/escrow/credentials.key`, `--file ~/tmp/token.txt`) and tell the operator to delete plaintext input files.
- `init` refuses a resolved key directory under the repository root. `key export --output` and `reveal --output` refuse destinations under the repository root, with a value-free message. `doctor` flags a key directory inside the repository.
- Reword draft:262 to: "Backup copies the repository tree. Keys are excluded only because they live outside it."

### C2. Key files and the init Pending state

- **Name key files by key ID, not vault ID** [inferred]. The default directory, `~/.config/effectory/keys`, is per user and shared by every repository. Two repositories that both declare `credentials` would otherwise collide on an exclusive create, and an export/import could pick the wrong file. The draft says key IDs are non-secret (draft:256) but never states the file name.
- **Pending with no file in the resolved directory**: replace the Pending row with a new random key ID, then create the file. Reusing the ID would let a rerun under a different `EFFECTORY_KEY_DIR` (draft:256 admits this can happen) create a second file with the same ID and different bytes. The keyed check would later catch it as KeyMismatch, but the operator would be left holding two "matching" escrow files. No ciphertext can exist while Pending, so rotating the ID costs nothing.
- `describe` reports a Pending vault as `NotInitialized` with an "init interrupted; rerun init" hint. Only `init` creates a stored identity: registering a vault, `describe` and a failed `put` do not consume one of the 128 slots.
- `init`, import and Pending/Ready transitions never advance the version counter. Without that rule the walkthrough's `--if-version 1` (draft:279) would be wrong.

### C3. Pruning order and scope

Add to draft:240/248: "When a put must prune to fit, it checks CAS against the pre-prune state. It then prunes the oldest tombstone, never the target key's row, together with that tombstone's receipts, and advances the absence token. The new version is issued after that, all in one transaction." Also specify delete on a key that is Absent or already Deleted: it fails `NotFound` and issues no token. Then a delete never creates a tombstone that has no prior value.

### C4. "Infallible local acquisition" must include the store file

Draft:182 has one daemon-owned `LocalStore` that owns the `vaults.sqlite` connection. If opening, migrating or schema-checking that file fails (corruption, a schema written by a newer binary, a full disk at first creation), the daemon would fail before any revision loads [inferred]. That is the B1 deadlock again, and per-vault reset cannot repair a file-level failure.

Smallest fix: create and open `vaults.sqlite` lazily on the first vault operation, so repositories without vaults never get the file. A file-level failure fails that operation (`VaultFailure{Corrupt}` / `Unavailable`) and never daemon startup. `doctor` reports it. The documented recovery is to restore the file from a backup, or move it aside offline (losing every local vault). That is a documentation step, not a new command.

### C5. Physical growth: WAL and shm, not just the page cap

[tested, at an 8 MiB scale]

- Filling to `max_page_count` gives `SQLITE_FULL`. At the hard cap, a delete transaction (drop the ciphertext, then insert a receipt), an evict-then-insert, and a full vault reset all still succeeded, because the same transaction freed pages first. Draft:244's "delete/reset remain possible" therefore holds at the physical cap too, for operations that free a value. Keep this in gate 4.
- With `secure_delete=ON`, the WAL grew to **11.8 MiB during a reset of an 8 MiB database** (about 1.4×). With it off, the WAL was 3.4 MiB. At the 64 MiB cap, that is roughly 90 MiB of WAL. That stays under the 128 MiB per-file limit, but WAL is separate from the page cap.
- `max_page_count` is per connection and read back as the default after reopening. Every opener, including offline commands, must set it.
- After `close`, `p.sqlite-wal` (0 bytes after a TRUNCATE checkpoint) and `p.sqlite-shm` (32 KiB) **remained on disk** on this platform.

[source] Backup excludes only `.effectory/state.sqlite-shm` and `state.sqlite.owner*` (`backup.ts:65–66`). It would copy `vaults.sqlite-shm` and any leftover WAL at its high-water size.

Smallest fix:

- Add `vaults.sqlite-shm` to the backup exclusions.
- Run a TRUNCATE checkpoint (or set `journal_size_limit`) after reset and prune and at clean close.
- Either leave `secure_delete` off (consistent with draft:262, which already disclaims erasure) or budget about 1.5× the page cap for the WAL.
- Gate 4 measures the database and WAL together after an unclean stop.

### C6. Admin error-to-code mapping and exact replies

`OperationError` has a fixed code set (`runtime/src/protocol.ts:114–128`) [source]. Draft:296 maps only Conflict. Add one table:

| Vault error | `OperationError` code |
| --- | --- |
| Absent or Deleted on reveal or delete | `NotFound` |
| `NotInitialized`, `KeyMissing` | `Unavailable` |
| `KeyMismatch`, `Corrupt`, `Closed` | `Unavailable` |
| `Unsupported`, `InvalidDefinition`, put on an undeclared key, `SecretInvalid` | `InvalidInput` |
| Logical budget | `LimitExceeded` |
| `SQLITE_FULL` / page cap | `StorageFull` |

Every message is value-free and names the vault and key. The message carries the permanent-versus-recoverable distinction, because the code set has no finer distinction.

---

## 4. Smaller items: implementation or gates, no presentation change needed

1. **Recommended provider pattern** (draft:192). Say "read bootstrap Config and create credentialed clients inside `read` (memoized if needed), not at acquisition". A provider bootstrapped from a local vault declares that vault's Definition in its Implementation `R` and reads it inside `read`, where the read is managed. A read at acquisition would be `Unmanaged` under the new ban. The existing `Implementation<E, R>` type covers this; show it in one line. Acquisition-time logs go to the daemon log, not run telemetry. State that alongside draft:218.
2. **Exact input.** Preserving a trailing newline is correct but invites the footgun `echo token | put --file -`. Emit a value-free stderr notice, "value ends with a line break; stored exactly", like the short-value notice. "Refuses TTY stdin" should read "refuses a terminal input source", which also covers `--file /dev/tty`. Accept only regular files and pipes.
3. **Uncertain delivery across a revision change.** Receipts are keyed by store, not revision, so a retry still replays if the vault in the newly active revision is still local. If the provider changed, the retry gets `Unsupported`. The hint should print `--revision R` whenever the CLI knows R, and otherwise say "if the active revision changed, add `--revision` with the earlier one".
4. **Orphaned vaults.** Online reveal or delete of a vault removed from the active source works through `--revision` naming an older revision that registers it. [source] Today every manifest directory up to 128 is retained, and I found no prune command (`revisions.ts:121–186`). Say so, as the way to drain a renamed vault before `reset`. A vault registered by no retained revision is reset-only.
5. **Offline reset** of a vault ID that is not stored returns `NotFound` and does not advance the absence token.
6. **Receipts** are dropped together with their key row whenever a tombstone is pruned. Add to gate 4 that a store at 4,096 receipts still accepts delete and reset (the probe suggests it will).

---

## 5. Checks with no finding

- **Read-only public backend; local mutation stays private.** Draft:146–182 and 298 are consistent. A custom `LocalStore.open` grants reads only. `memory` and remote providers return `Unsupported` before any write. Reserved `effectory/` provider IDs are kept.
- **Raw exact UTF-8.** `--file PATH|-`, a 64 KiB bounded read in the CLI, valid UTF-8 required, no argv value, reveal of raw stored bytes with no newline, refusal of `--json`, and `--output` created exclusively with mode 0600 (draft:292). All consistent with round 2.
- **Per-vault roots.** Resetting a vault deletes only that vault's metadata and leaves key files in place (draft:264). Draft:254 records the escrow-file count as a user tradeoff. Isolation holds [inferred]: a lost key for one vault cannot strand another.
- **Bounds arithmetic.** At 128 × 256 key records, about 300 bytes of metadata per row plus the primary-key index, 16 MiB of ciphertext and 4,096 receipts, a fully packed store comes to roughly 35–50 MiB of pages [inferred]. That is under 64 MiB without much margin under churn, so the physical proof in gate 4 is still needed. A put stopped by the page cap fails `StorageFull`, and the C5 probe shows the remedies still run.
- **Backup honesty** (apart from C1/C5). The draft says the run-history file and the 1 GiB total are not guaranteed, that older backups stay decryptable with the old key, and that whole-snapshot rollback is not detected.

---

## 6. Consequences the presentation must state (not new decisions)

1. **Old provider bootstrap config must stay available for as long as old revisions are retained.** Every retained revision rebuilds its providers at startup (`revisions.ts:161–186`), and nothing prunes revisions today. So after switching from an extension provider to `local`, removing that provider's daemon environment variables makes startup fail until they are restored. This follows from the existing revision model and the draft's honest draft:192. The recommended lazy-provider pattern (§4.1) is the mitigation.
2. **Absence tokens are global.** Any reset, or any online tombstone prune in _another_ vault, changes the token for every absent key. A create prepared earlier then gets a safe Conflict and needs a fresh `describe`. Draft:248 says this; the user list at draft:328 should name it under "reset fences".

The draft:328 decision list is otherwise complete. Optionally deferring provider acquisition failures inside `Vault.layer` would be a new decision and an implicit lazy-Layer mechanism. I recommend against raising it: the draft deliberately rejects that mechanism, and §4.1 covers the practical case.

---

## 7. Conditional approval

Approve for presentation **once C1–C6 are applied**. They are wording, examples and single rules in the existing sections. No new API family or command is needed. Add to the proof gates: the C3 prune-order case, file-level open failure (C4), WAL and shm size after an unclean stop plus backup exclusion (C5), key-file naming across two repositories sharing one key directory (C2), and refusal of paths inside the repository (C1). This approval is mine as a reviewer only. The user has not approved anything, and implementation remains unauthorized.

# Run tags — consumer review, round 1

Reviewer: Claude, from the consumer's side: workflow and task authors, extension authors, and CLI/RPC operators. Subject: `docs/run-tags-api-draft.md` (revision 1).

**Verdict: CONDITIONAL APPROVAL FOR PRESENTATION.** Four exact, small fixes are required, listed under B1–B4 below. With those fixes it can be presented. The overall shape is right:

- one optional `tags` on `Workflow.Spec` and on schedules
- a frozen `context.tags` that is always present
- `--tag KEY=VALUE` on submission and on `run list`
- inheritance into publications
- a capability gate

The proposal adds no Layer, handler parameter or graph node. Each blocker is a sentence-level change to the proposal, not new mechanism. Without the fixes, three of the walkthroughs fail in practice: finding runs, scheduled defaults after a deploy, and inherited artifact tags.

Reviewer approval is not user approval. The proposal remains **NOT APPROVED** for implementation.

Labels used below:

- **[fact]**: inspected in source, or observed in a scratch probe outside the repository.
- **[inference]**: reasoning from inspected facts.
- **[untested]**: a proposed API example. It cannot typecheck against the current code because the API does not exist yet.

---

## What I verified

- **[fact] The context has one production constructor.** It is `taskContext` at `packages/platform-bun/src/interpreter.ts:64-104`. It already copies and freezes `run.schedule`. Adding `tags: Object.freeze({...run.tags})` there reaches linked children, branches, fan-out, patches and replacement implementations, in the same way the occurrence feature did.
- **[fact] Publication tags are already part of identity.** `lake.ts:191-213` limits `canonical(options.tags ?? {})` to 8192 bytes and puts `tags` in the publication fingerprint. `artifactId` is `sha256(principal, taskId, output, key)` (`lake.ts:296`). It does not include `runId`, so runs with different tags produce new _versions_ of the same artifact. That matches the draft's "new version can have different tags".
- **[fact] `Task.test` does not check the tag byte limit today.** It fingerprints tags but never checks the 8192-byte limit (`task.ts:277-303`), and `TestPublication` has no `tags` (`task.ts:211-215`). The draft's items 5 and 11 are therefore real new work, and they are needed.
- **[fact] Lake tag predicates exist.** `lake-query.ts:90` reads `row.record.tags`. No new query syntax is needed.
- **[fact] Manual dedup happens before definitions are resolved.** `lookupSubmission` (`host-store.ts:1017-1042`) and the insert transaction (`:480-504`) each compute the same fingerprint, `{input, kind, revision, targetId}`. Both must change together, as the draft says.
- **[fact] Today `Workflow.make` silently accepts a `tags` key.** In a scratch probe, `Workflow.make({..., tags: {team: "x"}}, …)` produced no type error and kept `spec.tags` at runtime. Today it is ignored. `WorkflowSchedule.make({..., tags})` fails both at type level (TS2353) and at runtime ("Unsupported schedule option"). The draft's synchronous validation is new behavior for workflows.
- **[fact] The CLI already has the pieces the walkthrough needs.** It has `--request-key` with a "delivery is uncertain" hint (`packages/cli/src/main.ts:279-301`), and the `--json` shared flag works after the subcommand (`main.ts:47-52`, `README.md:90`).
- **[fact] The client never reads `ServerHello.capabilities`.** `client.ts:60-71` checks only `instanceId`. `schedule.v1` is advertised but not consumed. Item 12 is therefore the first capability the CLI actually enforces, and it needs its own plumbing.
- **[fact] `RunListRequest` is decoded with `onExcessProperty: "error"`** (`run-history.ts:115`). An old server therefore rejects a `tags` filter loudly rather than ignoring it. Submissions go through `Submit` in `rpc.ts:70` and use the default decode, so the capability check still matters for them.
- **[fact] The Swamp citations resolve:**
  - `workflow_run.ts:242-246`: `--tag`, collected
  - `execution_service.ts:3666-3669`: `{...workflow.tags, ...runtimeTags}`
  - `model.ts:253-254`: `runtimeTags`
  - `workflow_run_search.ts:234-238`: tag filter
  - `data_writer.ts:1231-1267`: the write order

  See D1 for a precision problem in how the draft describes the precedence.

## Blockers (each with its smallest fix)

### B1. `run list --tag <correlation-id>` fails on any busy repository

**[fact]** Run history filters in JavaScript after a SQL scan. `readRows` (`run-history.ts:40-104`) selects every row for the principal in the time range and counts each one toward `scanned`. It then applies `matches()`, which today covers kind, target and status. Above 10,000 scanned rows, or 16 MiB, it throws `QueryBudgetExceeded` with "narrow the time range". It never returns a partial page.

**[inference] Counterexample.** The example schedule in `examples/scheduled` runs every minute, so a repository passes 10,000 runs in about a week. After that, `effectory run list --tag deployment=deploy-42` with one matching run scans all rows and fails, unless the operator already knows the time window. The run's time window is exactly what a correlation-ID lookup is meant to find, so the draft's headline "find runs" use case breaks.

The draft says "Parameterize SQL values _if_ pushing tag predicates into SQLite". That makes pushdown optional, and without pushdown the feature is unusable.

**Smallest fix (wording).** Replace that sentence with:

> Tag predicates must be evaluated in SQLite (parameterized; for example a `host_run_tags(runId, key, value)` side table or `json_each`), so the existing 10 000-row/16 MiB budget counts only matching rows.

Add an acceptance test: more than 10,000 untagged runs plus 1 tagged run; `run list --tag` returns exactly that run without `QueryBudgetExceeded`. An index is an optional implementation choice.

### B2. Editing a workflow's default tags silently drops scheduled catch-up runs

**[fact]** A schedule's digest change resets its watermark. `schedule-store.ts:321-360` hashes `{catchUp, cron, input, scheduleId, timeZone, workflowId, workflowVersion}`. On a digest change it bumps the generation and writes `watermark = now` and `pendingSlot = NULL`. A non-digest change updates only `revision` and `definitionJson` (`:361-365`). That non-generational path is how `description` already behaves.

The draft puts the _effective merged_ tags into the digest. So editing `tags: { team }` on a **workflow** creates a new generation for every schedule of that workflow.

**[inference] Counterexample.** An hourly schedule has `catchUp: { latestWithin: "3h" }`. The daemon is down from 09:30 to 12:10 for a deploy that renames `team: platform` to `team: data`. On restart, reconciliation resets the watermark to 12:10. The 12:00 catch-up slot is never admitted. Because it is behind the new watermark, it is not recorded as missed either.

The same deploy without the label edit _does_ catch up. Graph changes without a version bump, and description edits, do not reset the schedule. Today only a workflow-version or schedule-config change resets it. A metadata label should not be stronger than a code change.

The new generation also reaches `context.occurrence.generation`. A previous review (scheduled-task-context B3) warned consumers about relying on that value, and a label edit now changes it.

**Smallest fix.** Treat effective tags like `description`:

- Store the effective map in `definitionJson`.
- Exclude it from the digest.
- Update it non-generationally.
- Admissions read the stored snapshot, so no admission consults live source. Admissions after reconciliation use the new map.
- Pending retries keep their unchanged request key. Scheduled fingerprints do not include tags, because there is no caller-supplied map.

Update Proofs §4 to "tag-only changes do not bump generation or watermark".

If the author keeps the generational rule anyway, the proposal must at least state the consequence in user-facing terms: "editing a workflow's default tags restarts all of its schedules and forfeits pending catch-up".

### B3. Inherited run tags can use up the whole publication tag budget

**[fact]** Run tags and the merged publication tags share the same 8192-byte limit (draft §Tag schema; `lake.ts:194`).

**[inference] Counterexample.** An operator submits `--tag` values with a total canonical size of 8,100 bytes. That is legal. A task that has always published `{ tags: { kind: "daily-summary" } }` now fails with `LimitExceeded` on every publication. The failure is caused by operator input, it happens after earlier steps have had side effects, and it cannot be fixed by the author because inherited keys cannot be removed (deferred). `Task.test` with the author's fixture passes, so tests do not reveal the problem.

**Smallest fix.** Pick one:

- (a) **Preferred.** Lower the run-tag map budget to 4096 canonical bytes. This guarantees at least 4096 bytes for explicit publication labels and costs nothing.
- (b) Keep 8192, but require the failure message to name the cause ("inherited run tags (N bytes) + publication tags exceed 8192") and add an acceptance test for it.

In either case, document the headroom rule next to item 11.

### B4. The compatibility claim does not cover a new CLI reading from an old server

**[fact]** `Run` and `RunSummary` are plain `Schema.Struct`s (`protocol.ts:30-44`, `history-protocol.ts:25-34`). The draft makes `tags` **required** on both.

**[inference]** A new CLI talking to an old, still-running daemon fails to decode _every_ `run get`, `run list`, `run watch` and foreground result, including untagged ones. That contradicts "Existing untagged commands continue to work".

**Smallest fix.** Pick one sentence:

- (a) Client-side decoding treats a missing `tags` as `{}`, while servers always emit it.
- (b) State that a CLI/daemon version skew is unsupported. The CLI then refuses servers that lack `run-tags.v1` for all run reads, with an actionable "restart the daemon" message.

Either is fine. The draft must pick one and test it.

## Deliberate deviations

### D1. Explicit publication tags win over run tags — **ACCEPT, but fix the citation and document the idiom**

From the author's side, the draft's precedence is strictly more expressive than Swamp's:

- A task that wants operator-wins precedence can write `tags: { kind: "summary", ...context.tags }` **[untested]**.
- Under Swamp's order, a task can never protect a label it owns.

The cost is real. **[inference]** A task that hard-codes `{ env: "dev" }`, a common copy-paste leftover, silently relabels the artifacts of an `--tag env=prod` run. `lake query tag env=prod` then misses them, while `run get` says `env=prod`. That is acceptable only if it is documented.

Required:

1. **Precision.** Swamp's runtime tags beat _model-spec and method_ output tags. Swamp's **per-step `dataOutputOverrides` tags are applied after `runtimeTags`, and they win** (`vendor/swamp/src/domain/models/data_writer.ts:1250-1267`; see also the comment at `model.ts:253`). Reword the claim as: "Swamp: code-declared output tags lose to runtime tags; workflow-step output overrides win."
2. Add the operator-wins idiom above, and one sentence saying that a task's hard-coded key overrides the operator's value for that artifact.

### D2. Inherited keys cannot be removed — **ACCEPT for this slice, conditional on B3**

Removal mainly matters for budget relief, which B3 handles, and for high-cardinality correlation IDs stamped on a shared, versioned artifact. Explicit override to a different value covers the labelling need. Removal and opt-out stay in "Explicitly deferred". The proposal must keep the `{ tags: {} }` does-not-clear rule visible in user docs, because authors will expect it to clear.

### D3. Linked child defaults are ignored — **ACCEPT, but disclose it as a Swamp deviation**

**[inference, partial trace]** Swamp's nested-run path passes the child's `workflowTags: resolvedWorkflow.tags` together with the parent's `runtimeTags` (`execution_service.ts:4735-4747`, `:2571-2573`). So a Swamp child's own workflow tags do label its outputs, with runtime tags winning.

The draft drops a linked child's defaults. That is a reasonable simplification, because there is a single run map and no scopes. But:

- it is a second Swamp deviation and must be listed beside D1
- `workflow describe child` shows defaults that do not apply when the child is linked; add a one-line note that "defaults apply when this workflow is the submitted root"

## Walkthrough notes (no change required)

- **Defining defaults.** `Workflow.make({..., tags})` with frozen capture is the right place. Today an unknown `tags` key is silently kept (see What I verified), so a user on an older SDK pin gets a no-op. The pinned-SDK model (`repo upgrade`) makes that unlikely. A typo such as `tag:` is still silently accepted after this change, but that is pre-existing behavior of `Workflow.Spec`, so it is out of scope.
- **Manual overrides and repeat submissions after a deploy.** The rules are right: the fingerprint covers supplied tags only, omitted and `{}` are equivalent, and dedup happens before definitions are resolved. Retrying with the printed `--request-key` after a deploy returns the original run and its original tags. Changing `--tag` under the same key gives Conflict. The CLI's uncertain-delivery hint should also say "with the same --tag values".
- **Task fixtures.** `Task.test(Inspect, { input: null, tags })` mirrors `occurrence` well. `TestPublication.tags`, which shows the merged result, is the most useful addition for extension authors. It is how they verify D1 behavior.
- **Naming.** `RunTags`, `context.tags` and `--tag` are consistent with Swamp and with the existing publication `tags`. No new top-level command is the right call.
- **Visibility.** `schedule get` showing the effective map, and `workflow describe`/`plan` showing the defaults, give operators enough to predict a run's tags. The D3 note covers the one gap.

## Acceptance tests to add or tighten

1. **(B1)** More than 10,000 untagged runs plus 1 tagged run: `run list --tag k=v` returns it without `QueryBudgetExceeded`. Cursor pages under a tag filter stay stable during concurrent admissions.
2. **(B2)** Changing only workflow default tags: generation, watermark and `pendingSlot` are unchanged, and the next admitted run carries the new map. A catch-up slot is still admitted across a restart that changes tags.
3. **(B3)** A maximum-size run-tag map plus a small explicit publication tag succeeds (if fix a), or fails with the cause-naming message (if fix b), in both `Task.test` and the real lake.
4. **(B4)** New client against a server response without `tags`: either decodes as `{}` (a) or gives the refusal message (b). Covers `run get`, `run list` and `run watch`.
5. **(D1)** Explicit override wins. The `...context.tags` idiom restores operator precedence. `{ tags: {} }` keeps the inherited labels. The lake query on the inherited key finds the artifact.
6. Keep the draft's Proofs 1–9 as written.

## Summary of required edits

| # | Edit |
| --- | --- |
| B1 | Make SQL pushdown of tag predicates mandatory, so the scan budget counts only matching rows. |
| B2 | Make effective tags non-generational, like `description`, stored in `definitionJson`. Or state the reset consequence explicitly. |
| B3 | Run-tag budget of 4096 bytes. Or a cause-naming overflow error plus a test. |
| B4 | Missing `tags` decodes as `{}` on clients. Or skew is explicitly unsupported and refused. |
| D1 | Correct the Swamp precedence description (`dataOutputOverrides` win) and document the `...context.tags` idiom. |
| D3 | List linked-child defaults as a Swamp deviation and note it in `workflow describe`. |

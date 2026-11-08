# Artifact reads — consumer design critique, round 2

Reviewer: Claude (consumer/developer-experience lens, with Effect-idiom checks where they affect consumers). This reviews the frozen [consolidated draft 1](artifact-reads-api-draft.md) against [round 1](artifact-reads-review-consumer-round1.md), the [Effect round-1 review](artifact-reads-review-effect-round1.md), the [research](artifact-reads-research.md), the [evidence](artifact-reads-evidence.md), and current source.

**This is reviewer feedback, not user approval.** "Approve" below means only that this reviewer has no remaining objection. Every public decision still needs the user. No production files, other docs or commits were changed. No probes were needed for this round: each new finding below comes from reading the cited source. Earlier probe results are cited by their round-1 IDs.

## Verdict

**Conditionally ready to present.** The architecture is right, and most of my round-1 blockers are resolved: a separate service, an addressable `latest`, typed retryable errors, report protection, a shared evaluator with indexed narrowing, and a real-digest fixture handoff. I do **not** reopen any of those.

Six corrections are needed before I would call the draft presentable. All of them are text changes to the draft. None needs a redesign or reduces scope.

| # | Correction | Area |
| --- | --- | --- |
| C1 | Fixtures must be able to set `runId`, and must get deterministic, monotonic `committedAt` and `sequence` | Test contract |
| C2 | `Report.test` must accept and forward `artifacts` | Test contract |
| C3 | Specify how fixture identity maps to an `artifactId` and how versions are ordered; give the fan-in remedy | Test contract |
| C4 | Content permits should wait for capacity owned by others, not fail fast with `Busy` | Runtime behaviour |
| C5 | Reporter reads of its own source run must not consume the 1,024-pin cap | Durability |
| C6 | Give a worked "acquire before you wait" recipe, which the first-access choice depends on | Durability / documentation |

After these, the remaining items are recommendations (R1–R7). They can be presented as open choices or fixed in passing.

---

## 1. Source facts used in this round (read 2026-11-06)

- **Synthetic references restart per harness.** `Task.test` allocates `test-artifact-${publications.length + 1}` and `test-digest-${…}`, with `version: 1`, keyed by `${output}/${key}` (`packages/core/src/task.ts:583-622`, `:674-697`). Two independent `Task.test` calls therefore both produce `test-artifact-1`. Nothing else in the repository depends on these strings: `git grep` finds them only in the recorder.
- **The harness run context is fixed.** `runId: "test-run"`, `attemptId: "test-attempt"`, `invocationPath: "task"`, `revision: "test-revision"`, `taskId: task.id` (`task.ts:588-735`).
- **`refSchema` does not constrain `digest` or `artifactId`.** Both are `Schema.String` (`packages/core/src/artifact.ts:8-16`). Synthetic references pass input encoding in a second `Task.test`, so the handoff `input: produced.value` type-checks and encodes.
- **Lake identity ignores schema.** `artifactId = sha256(canonical([principal, taskId, output, key]))`, and `version = MAX(version)+1` per `artifactId` (`packages/platform-bun/src/lake.ts:314-326`). A producer that bumps its schema keeps the same `artifactId`.
- **"Latest" ranks across schemas.** The `versions: "latest"` subquery checks `newer.artifactId` with **no** schema predicate, while the outer scan is schema-bound (`packages/platform-bun/src/lake-query.ts:288-294`). A V1-bound latest query silently omits an identity whose newest retained version is V2.
- **Order ties break by `artifactId` ascending, then `version` ascending** (`lake-query.ts:234-251`). With no `orderBy`, rows are in `sequence` order.
- **Lake `Record` has these fields:** `runId`, `attemptId`, `invocationPath`, `revision`, `sequence`, `committedAt`, `bytes`, `tags`, `taskId`, `output`, … It has no `key` (`packages/runtime/src/lake-protocol.ts:101-119`).
- **`Report.test` cannot seed artifacts today.** It calls `Task.test(task.provide(Layer.succeed(History, history)), { input, tags })` with no artifact option (`packages/core/src/report-test.ts:217-220`). `Source.runId` is any non-empty string of at most 200 characters (`report-history.ts:8,20-30`).
- **Report record statuses** are `WaitingSource | Queued | Running | NeedsAttention | Succeeded | Failed | Cancelled | NotApplicable` (`report-record.ts:15-24`). Report-hold behaviour against real store transitions is recorded in the updated evidence doc (hold set and cleared by cancellation, retry re-arms the hold, reclaimed data stays `NotFound`).
- **Cancel by source exists.** `ReportCancelSourceRequest { sourceRunId }` is part of the protocol (`packages/runtime/src/report-protocol.ts:53-57`), so `protection.reportSourceRunId` gives the operator something to act on.
- **Wait nodes take `after` and a required `timeout`** (`packages/core/src/workflow.ts:165-170`), and task nodes accept `after` (`:26-27`). The recipe in C6 uses only these.

## 2. Assessment of the consolidated decisions

| Decision | Consumer verdict | Notes |
| --- | --- | --- |
| Separate `ArtifactReader`: get/stream/bytes/metadata/latest/query, plus `ArtifactQuery.stream` | Approve | Same reasoning as round 1 (P2). Keeping the helper off the service keeps fakes small. |
| `latest` with explicit `taskId/output/key`, no query `key` field | Approve, with R1 | Explicit is better than my round-1 "current task by default", because it reads the same in a reporter, a helper and a Layer. `Collect.id` is fine. The cost is that `output` is an unchecked string; a typed overload can be added later. Rows still don't show the key; state that (R1). |
| `versions` required; `limit` default 50, max 200 | Approve | Matches round 1. |
| Two error tags, declared explicitly in task schemas | Approve | I accept explicit declaration over implicit handler widening. Undeclared errors are a compile error (Effect T1), not a silent host failure, and `Effect.orDie` is one call. The boilerplate is visible in the example. That is honest, and the example shows workflows re-declaring the union. |
| First-access pins, no admission pins | Approve, conditional on C6 | See §4. I withdraw my round-1 admission-pin recommendation. |
| Report-source protection for all unsettled generations | Approve, with C5 | The evidence probe of the SQL predicate across real report transitions is enough for presentation. |
| 1,024 external pins per run | Approve, with C5 | Fine for ordinary tasks. Report-source reads must not count (C5). |
| Four content permits, fail-fast `Busy` | **Object** (C4) | See §5. |
| Operator `protectedBy` counts and per-version `protection` details | Approve, with R5 |  |
| Full shared evaluator, indexed narrowing, no weaker fixture DSL | Approve, with R3/R4 | This answers my round-1 time-bomb concern and gives fixture parity. |
| `bytes` (verified, ≤ 16 MiB) next to `stream` (EOF-verified) | Approve | Bytes artifacts are capped at 16 MiB, so `bytes` covers every artifact. `stream` exists only for memory and latency. The stream disclosure matches the evidence (three frames delivered before `ContentUnavailable`; `take(2)` never verified). |
| Task.test fixtures with real digests, a shared recorder, and an `artifacts` result | Approve the shape; C1–C3 needed | See §3. |

## 3. Task.test fixtures: does the round trip really work?

### 3.1 What works as drafted

I traced the draft's two-stage example against `task.ts`.

1. `Task.test(Collect, { input: "platform" })` publishes `{ artifactId: "test-artifact-1", digest: "test-digest-1", version: 1 }`. `produced.value` is that reference, and its type is `Inventory.refSchema.Type`.
2. `Task.test(Inspect, { input: produced.value, artifacts: produced.artifacts })` encodes the input through `Inventory.refSchema`. This passes because `digest` is a plain string.
3. The harness reader finds `(test-artifact-1, 1)`, accepts the synthetic digest alias, and checks schema ID, version and kind. It decodes the stored encoded JSON with `Inventory.schema` and returns the value.

Own-publication reads in the same test also work: publish, then `get` the returned reference, `latest(Collect.id, output, key)` or `query`. Exact refs are preserved, and production readers reject `test-digest-N` with `DigestMismatch`. This was round 1's B5 and it is resolved.

### 3.2 Holes

**C1. Fixture metadata is incomplete, and default timestamps invert history order.**

- `Metadata` extends the lake `Record`, so every fixture row must carry `runId`, `attemptId`, `invocationPath`, `revision` and `sequence` as well as the six drafted options. The draft does not give their defaults.
- Without a `runId` option, **the draft's own reporter pattern cannot be tested.** That pattern is `metadata.runId = source.runId`. An `Artifact.fixture` row would carry some unspecified run ID that `Report.test`'s `source.runId` cannot be set to match on purpose.
- The default `committedAt` is the same instant (1970) for every fixture. Ties then break by `artifactId` and **version ascending** (fact §1). So `orderBy: [{ committedAt, desc }]` over v1, v2 and v3 of one identity returns **v1 first**, the opposite of production. A "compare with previous" test using defaults would pass or fail for the wrong reason.

Correction:

- Add `runId?` to fixture options (default `"fixture-run"`). Document fixed defaults for `attemptId`, `invocationPath` and `revision`.
- Assign `sequence` in seeding order, then own publications in publish order.
- Default `committedAt` should be monotonic in `sequence` (for example `epoch + sequence ms`) when not supplied. Own publications follow the same rule, so the harness has no wall-clock time.
- For one identity, a higher `version` must also have a higher `sequence`. Otherwise it is a fixture error.

**C2. `Report.test` is not wired.** It builds its own `Task.test` call and has no `artifacts` option (fact §1). Reporters are an explicitly scoped consumer, so add `artifacts?` to `Report.test` and forward it.

Document the handoff rule: `produced.artifacts` from `Task.test` carry `runId: "test-run"`. A reporter test that reuses them must therefore set `source.runId: "test-run"`. The alternative is to build fixtures with an explicit `runId`.

**C3. The identity → `artifactId` mapping is unspecified, and fan-in fails.**

- _Mapping._ The draft never says how `Artifact.fixture` computes `artifactId`. Specify the lake formula over a fixed harness principal: `sha256(canonical([harnessPrincipal, taskId, output, key]))`. Then state the invariant: within one seeded store, a logical `(taskId, output, key)` maps to exactly one `artifactId`.
- _Cross-source conflict._ Without that invariant, a consumer test can combine an exported own publication (`test-artifact-1` for `collect/inventory/platform`) with an `Artifact.fixture` for the same identity (a hashed ID). Two `artifactId`s for one identity would make `latest` and `versions: "latest"` ambiguous. This must be the explicit conflict error.
- _Mixed references._ Publishing in-test to an identity seeded by `Artifact.fixture` yields `{ artifactId: <real hash>, digest: "test-digest-N", version: k+1 }`. This mixed reference is acceptable as a harness-only alias, but say so.
- _Fan-in._ Two producers tested independently both mint `test-artifact-1`, so `[...a.artifacts, ...b.artifacts]` is the "explicit fixture error" the draft describes. That is the natural way to test a consumer of two producers, so it will be the first error authors hit. Exact-ref preservation rules out renaming aliases afterwards, so the remedy is **threading**: seed the second producer with the first's artifacts, which makes its new aliases avoid them. Document this pattern (example E2) and make the collision error message name it. Seeding a producer is harmless: its publications to an unrelated identity are unaffected.
- _Default identity._ `taskId "fixture"`, `output "value"`, `key = artifact.id`. Two fixtures of one definition without a key or version therefore conflict, which is the usual "two inventories" test. Either keep this and have the error text say "give each fixture a distinct `key`, or a `version` for history" (minimum), or default `key` to `${artifact.id}-${digest[0..16]}` so distinct values never collide (R7). Because the lake `artifactId` ignores schema, any default key must keep the definition ID, as the current default does.

**Typing.** `Fixture<A>` exposes a covariant `.reference: A["refSchema"]["Type"]`. A heterogeneous `readonly Artifact.Fixture[]` and spreads of `produced.artifacts` should therefore assign without casts. A generic fake's `get` still needs a cast from stored `unknown` (Effect round 1, §9), as before. `Artifact.fixture` returning an Effect, because SHA-256 is computed asynchronously in core, is acceptable. Its value is to replace my round-1 `as never` decode workaround.

## 4. First-access versus admission pins

I withdraw my round-1 admission-pin recommendation. The reasons are the author's own semantics, not preference.

1. **Unused references.** Input schemas can carry references the run reads only on some branches. An admission pin protects versions nobody may read and takes slots from the 1,024 cap. It also shows up as `consumerVersions` with no reader. That misinforms operators, which the hold-visibility design tries to prevent.
2. **Admission semantics.** A failing admission pin rejects a run because a reference it would never touch was reclaimed, which changes submission behaviour. A non-failing admission pin only narrows the window. The reference can already be reclaimed between query and submit, so `Reclaimed` handling is needed anyway.
3. **Mechanism.** Walking the input schema's AST through unions, suspends and transformations is the fragile part I flagged in round 1 as a fallback trigger. The draft rightly refuses to scan JSON.

The real residual risk is a **durable wait between admission and first read** (approval or signal, possibly for days). The evidence probe reproduces exactly this: a `Waiting` consumer's input reference was reclaimed. First-access is acceptable only if the remedy is a documented, idiomatic pattern rather than a sentence. That is C6 (example E3): an acquiring node before the wait, whose `metadata` call pins for the life of the run. Add it to the docs and to proof gate 4.

## 5. Content permits (C4)

The draft proposes four daemon-wide permits, and a fifth concurrent `get`/`stream`/`bytes` fails `ArtifactUnavailable{Busy}`.

- **Load becomes run failure.** Report execution alone is capped at four (`run-reports-api-draft`). Four reporters streaming at once take every permit. A workflow task that then calls `get` fails. If its author did not declare `ArtifactUnavailable` (the `orDie` style the draft endorses), the run fails for reasons unrelated to its own code. With a declared retry, the whole attempt is re-run after a delay. That is a coarse and costly response to a momentary queue.
- **Self-inflicted `Busy` is not transient.** `Effect.forEach(rows, get, { concurrency: 8 })` in one task fails every attempt the same way. Tagging it as retryable `Busy` sends authors to `retry.when`, which cannot help.
- **The Effect idiom is waiting.** Waiting on a semaphore is interruptible and runs under the existing attempt timeout. It gives the same descriptor and buffer bound (4 × 16 MiB) without converting contention into errors.

Correction (the numbers remain the parent's and the user's to choose):

- Acquire daemon permits by **waiting** (FIFO, interruptible, counted against the attempt timeout).
- Fail fast only when **one invocation** exceeds its own in-flight cap. That case is deterministic, so give it a permanent reason (for example `ArtifactReadError{ConcurrencyLimit}`), not `Busy`. This also covers the self-deadlock case: an invocation holding open streams and asking for more fails at once instead of waiting until timeout.
- Keep `Busy` for SQLite contention only.
- The harness applies the per-invocation cap with the same reason, so tests show over-subscription.

If the user keeps fail-fast, the draft must at least say that reporters and ordinary tasks compete daemon-wide, and that undeclared `Busy` fails the run.

## 6. Reporter reads and the pin cap (C5)

- A reporter that reads its source run's publications is reading versions already protected by the report rule. That protection lasts while the record is `Running` or `NeedsAttention`, which covers the reporter run's lifetime, and a retry re-arms it (evidence).
- Recording pins for these reads is redundant, and **counting them** makes a reporter over a source with more than 1,024 publications fail with `PinLimit` partway through.
- Correction: inside a report run, reads of versions whose `runId` is that report's source run are exempt from pin recording and the cap, like same-run reads. Reads of other runs' publications pin as usual. Add this to proof gate 5.

## 7. Explicit `latest` across schema changes (R2)

The decision is sound: `latest` returns the newest retained version of the identity and fails if that version uses another schema. But the query and `latest` paths **diverge silently**:

- `latest(V1, id)` returns `SchemaMismatch` once the producer publishes V2.
- `query(V1, { versions: "latest" })` simply **omits** that identity, because ranking ignores schema (fact §1). A dashboard that counts V1 identities drops to zero after a deploy, with no error.

Required wording, with a remedy:

- State both behaviours side by side in the draft.
- `SchemaMismatch` from `latest` must populate `artifactId` and `version`. A consumer that wants "the newest version I can decode" can then fall back explicitly (example E4) without the CLI.
- Say which reason `latest` returns when every version of the identity is reclaimed. I suggest `Reclaimed` if any reclaimed history exists and `NotFound` otherwise.

## 8. Queries, cursors and the stream helper

- **R3: Scope cursor invalidation for `versions: "all"`.** The evidence shows that reclamation of an unrelated schema expires every cursor of the principal. For `versions: "latest"`, a principal-wide epoch is the simple correct rule, because ranking spans schemas. For `versions: "all"`, a per-`(principal, schemaId, schemaVersion)` epoch is sufficient. The reporter case (`versions: "all"`, `runId` = source) reads _protected_ rows yet fails `CursorExpired` whenever retention runs anywhere. This is internal, but the contract sentence "reclamation anywhere under that principal" should be narrowed or kept deliberately. If it is kept, say that reporters should prefer one page of up to 200 rows where possible.
- **R4: `Page.scanned` and `scannedBytes`.** These become optimizer-dependent once pushdown lands. Mark them diagnostic and unstable, or drop them from the task-facing `Page`. `matched` and `snapshot` are fine.
- **Document that `ArtifactQuery.stream` can fail after emitting rows** (`QueryBudget`, `CursorExpired`), just as `stream` can fail after emitting bytes. Consumers that act per row should collect first or deduplicate by `ref` on restart.
- The 100,000-unrelated-row proof gate and the pushed/non-pushed equivalence gate are the right obligations. The scratch expression-index probe shows exact-run lookup is feasible (one candidate), and the 10,000-row failure shows it is necessary.

## 9. Operator visibility (R5)

- `protection.consumerRunIds` returns at most 20 IDs plus `truncated`. Add `consumerRunCount` so the operator knows whether 21 or 2,000 runs hold the version. A boolean says nothing about scale.
- `reportSourceRunId` always equals the version's own `runId` when it is non-null. It is still useful, because it maps directly to cancel-by-source. Keep it, and point the CLI hint at that request.
- "Missing consumer state is conservatively protected" needs a named remedy. Without a run there is nothing to cancel. Specify that doctor reports orphaned pins, or that cleanup treats a missing run row as terminal after a stated condition.

## 10. Other notes

- **R1:** state that rows expose `taskId` and `output` but not `key`. Grouping by key needs a declared field or tag.
- **R6:** a later typed overload, `latest(Collect, "inventory", key)`, could infer the definition from `Collect.spec.outputs` and check the output name. It is additive and does not need to block this decision.
- **R7:** the digest-derived default fixture key (§3.2).
- `Closed` as an `ArtifactReadError` reason differs from publish's `TaskRuntimeError InvalidBoundary` (Effect round 1). For consumers it is fine either way, because it only appears for misuse after close. Note the asymmetry.

## 11. Corrected minimal examples (proposed API; not typechecked)

**E1: reporter test with fixtures (C1, C2).**

```ts
// PROPOSED
const fx =
  yield *
  Artifact.fixture(
    Inventory,
    { team: "platform", hosts: ["a", "b"] },
    { taskId: Collect.id, output: "inventory", key: "platform", runId: "src-1" }
  );
const result =
  yield *
  Report.test(InventoryReport, {
    source: {
      invocationId: null,
      revision: "r1",
      runId: "src-1",
      scope: "run",
      status: "Succeeded",
      targetId: "audit",
      targetKind: "workflow",
      targetVersion: 1,
    },
    outcome: { _tag: "Succeeded", value: 2 },
    artifacts: [fx],
  });
```

**E2: fan-in by threading (C3).**

```ts
// PROPOSED
const a = yield * Task.test(CollectInventory, { input: "platform" });
const b =
  yield *
  Task.test(CollectSnapshot, {
    input: "platform",
    artifacts: a.artifacts,
  });
yield *
  Task.test(Compare, {
    input: { inventory: a.value, snapshot: b.value },
    artifacts: b.artifacts, // contains a's fixtures plus b's own, with no alias collision
  });
```

**E3: acquire before a durable wait (C6).**

```ts
// PROPOSED
const Acquire = Task.make(
  {
    id: "acquire-inventory",
    version: 1,
    replay: "idempotent",
    input: Inventory.refSchema,
    success: Inventory.refSchema,
    error: ReadErrors,
  },
  (reference) =>
    Effect.gen(function* () {
      const reader = yield* ArtifactReader;
      yield* reader.metadata(Inventory, reference); // pins for the rest of this run
      return reference;
    })
);

// In the workflow graph: input reference → acquire → approval → inspect
const held = yield * graph.task("acquire", Acquire, reference);
const permit =
  yield *
  graph.approval("approve", {
    prompt: "Audit?",
    timeout: "7 days",
    after: [held],
  });
return yield * graph.task("inspect", Inspect, held, { after: [permit] });
```

**E4: explicit fallback after a producer schema bump (R2).**

```ts
// PROPOSED
const ref =
  yield *
  reader
    .latest(InventoryV1, {
      taskId: Collect.id,
      output: "inventory",
      key: "platform",
    })
    .pipe(
      Effect.catchTag("ArtifactReadError", (error) =>
        error.reason !== "SchemaMismatch" || error.artifactId === null
          ? Effect.fail(error)
          : reader
              .query(InventoryV1, {
                versions: "all",
                where: {
                  _tag: "Eq",
                  field: { metadata: "artifactId" },
                  value: error.artifactId,
                },
                orderBy: [
                  { field: { metadata: "version" }, direction: "desc" },
                ],
                limit: 1,
              })
              .pipe(
                Effect.flatMap((page) =>
                  page.rows[0]
                    ? Effect.succeed(page.rows[0].ref)
                    : Effect.fail(error)
                )
              )
      )
    );
```

The fallback's query row is not pinned. Follow it with `get` or `metadata`, which pin on success.

**E5: version-history fixtures (C1).**

```ts
// PROPOSED: same identity, explicit versions; committedAt defaults stay monotonic
const identity = {
  taskId: Collect.id,
  output: "inventory",
  key: "platform",
} as const;
const v1 =
  yield *
  Artifact.fixture(
    Inventory,
    { team: "platform", hosts: ["a"] },
    { ...identity, version: 1 }
  );
const v2 =
  yield *
  Artifact.fixture(
    Inventory,
    { team: "platform", hosts: ["a", "b"] },
    { ...identity, version: 2 }
  );
yield * Task.test(Inspect, { input: v2.reference, artifacts: [v1, v2] });
```

## 12. Public decisions to present to the user

1. A separate `ArtifactReader` with six methods, plus the `ArtifactQuery.stream` helper.
2. Explicit `latest(taskId, output, key)`, and its schema-change behaviour next to the query omission (R2).
3. `versions` required; `limit` default 50, max 200.
4. Two error tags, declared explicitly per task and workflow, with no implicit widening. Codec defects become `DecodeFailed`.
5. First-access protection plus the acquire-before-wait recipe (C6), instead of admission pins.
6. Report-source protection for all unsettled generations, with source-run reads exempt from the pin cap (C5).
7. A cap of 1,024 external pins per run, failing with `PinLimit`.
8. Content concurrency: waiting daemon permits plus a fail-fast per-invocation cap (C4), versus the draft's fail-fast `Busy`.
9. `bytes` (verified) next to `stream` (EOF-verified).
10. The retention amendment: the `protectedVersions` meaning, `protectedBy` counts, and per-version `protection` details (with `consumerRunCount`, R5).
11. Query budgets kept, with indexed narrowing, the cursor invalidation scope (R3), and `Page` diagnostics (R4).
12. The Task.test and Report.test fixture contract (C1–C3), including preserved synthetic aliases and the threading pattern.

## 13. Proof-gate additions

- Gate 2: two-producer fan-in via threading. A collision error whose message names the remedy. A `Report.test` reading seeded fixtures by `source.runId`. Own-publication `latest` and query in one test. A history `orderBy committedAt desc` using default timestamps returns the newest first.
- Gate 4: the acquire-before-wait recipe. Reclaim during approval, then a successful read after it.
- Gate 4/5: per-invocation over-subscription fails with the permanent reason. Cross-invocation contention waits and does not fail. A reporter reading more than 1,024 source-run versions succeeds.
- Gate 6: a V1 latest query omits an identity whose newest is V2. `latest` returns `SchemaMismatch` with `artifactId` and `version` populated, and the E4 fallback works.

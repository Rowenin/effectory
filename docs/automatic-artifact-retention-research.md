# Automatic artifact retention — source evidence and design probes

Status: original pre-implementation research, 2026-11-06. The user subsequently approved the [contract](automatic-artifact-retention-api-draft.md), and the collector is now implemented. See [implementation evidence](automatic-artifact-retention-implementation.md) for actual tests and verification. The model results below remain labelled as model evidence.

## Why this gap

The current [parity inventory](swamp-analysis.md) identifies automatic collection as missing. Effectory has captured artifact policies, manual plan/apply, durable tombstones/unlinks, consumer pins and report-source protection. These make automatic policy collection a smaller next slice than remote workers or configured-model instances. Those other gaps remain part of the overall parity objective.

Swamp evidence, read from the vendored source rather than executed:

- [Model method execution](../vendor/swamp/src/libswamp/models/run.ts), lines 1914–1947, checks `input.autoGc` after producing the completed method view and invokes `autoGc` for that model. [Repository context](../vendor/swamp/src/cli/repo_context.ts) reads the marker's opt-in `autoGc === true`.
- [autoGc](../vendor/swamp/src/libswamp/data/gc.ts), lines 294–359, collects version garbage and optionally expired whole entries. It catches/logs failures instead of turning them into method failure.
- [collectGarbage](../vendor/swamp/src/infrastructure/persistence/unified_data_repository.ts), starting at line 2961, examines promoted versions. Count and duration policies preserve the newest version. This is separate from whole-entry lifetime deletion.
- [RetentionGcService](../vendor/swamp/src/serve/retention_gc_service.ts) additionally provides a repository background pass, explicitly gated by `garbageCollection.automatic`, with a five-minute initial delay, hourly interval, five-minute pass budget and shutdown/manual-GC coordination.
- [RetentionPolicy](../vendor/swamp/src/domain/retention/retention_policy.ts) separates data retention from several other retention kinds. The proposed Effectory slice does not claim parity with those other kinds, whole-entry deletion, or Swamp's distributed hour claim.

## Current Effectory constraints

- [Artifact](../packages/core/src/artifact.ts) already accepts and validates `retention: { maxVersions?, maxAge? }` with Effect Duration. No new builder is necessary.
- [Lake](../packages/platform-bun/src/lake.ts) captures the policy on each publication. [Reclamation](../packages/platform-bun/src/lake-reclamation.ts), `identity` and `reason`, selects the newest publication policy including tombstones, preserves newest kept content, and uses age OR count. Its manual planner batches reads but can traverse the full store before finding 1,000 candidates. `identity.threshold` uses OFFSET; a very large count policy can therefore do substantial work in one statement.
- The manual apply transaction rechecks ranking and protections, writes tombstones and unlink jobs, and advances the cursor epoch. An automated caller cannot skip those checks. Its receipts stay indefinitely; creating one on every idle tick would add needless permanent metadata.
- [Protection](../packages/platform-bun/src/lake-protection.ts) covers unfinished producers, consumer pins, and unsettled report obligations. The automatic worker needs only the boolean checks, not the full operator-facing consumer count/list.
- [Lake startup](../packages/platform-bun/src/lake.ts), lines 590–609, acquires SQLite with `Effect.acquireRelease`, recovers binary installs, and attempts reclamation recovery with a warning on failure. Contrary to an older design assumption, reclamation I/O failure does not itself prevent readiness. The proposal preserves this distinction.
- [Host composition](../packages/platform-bun/src/host.ts), [scheduler](../packages/platform-bun/src/scheduler.ts), and [runner](../packages/platform-bun/src/runner.ts) already demonstrate shared services and scoped daemon fibers. A collector can use that same ownership structure; it does not belong in author tasks or the task-local Layer memo map.

## SQLite traversal model — tested, not implementation evidence

Scratch files: `/tmp/effectory-auto-retention-research/probe.ts`, `output.log`, `model.sqlite`. The model is a simplified SQLite schema, not the lake or the proposed collector. It tests an indexed descending version walk, persisted rank/checkpoint, identity mutation epochs and conservative rank restart. It has a boolean protection field, not real host/report/pin tables. It does not test age, filesystem cleanup, deletion receipts, asynchronous cancellation or API behavior.

The model seeded 1,000 identities with 200 versions each. The first 500 identities were protected; each unprotected identity kept its newest three versions. It closed/reopened SQLite partway through, then inserted a new version and manually deleted an old head while that identity's traversal was in progress.

Observed on this machine:

- 200,000 initial versions, 200,003 row inspections, 2,000 bounded steps.
- 98,500 automatic-model deletions; 101,500 kept rows; zero protected deletions.
- Exactly one rank restart after the interleaved publication/manual deletion.
- Persisted checkpoint survived closing/reopening the connection.
- At most 128 rows returned per content batch; `EXPLAIN QUERY PLAN` used `SEARCH versions USING INDEX retained (id=? AND v<?)`.
- Traversal took about 1.37 seconds total; the slowest observed batch was 8.60 ms. These are one-run model measurements, not production latency or throughput guarantees. Initialization is excluded.

Assertions passed. The model establishes feasibility of preserving progress without repeated whole-prefix scans. The real implementation still needs the contract's contention, protection, policy, age, crash and I/O proof gates. A continuously changing identity also needs a bounded restart/defer policy; that behavior is specified in the draft but was not tested by this model.

## Effect Layer/Scope ownership — tested, not implementation evidence

`/tmp/effectory-auto-retention-research/scope.ts` used the installed Effect 4.0.5. A fake storage Layer acquired/released a handle; a dependent `Layer.effectDiscard` forked a never-ending collector with `Effect.forkScoped`. Closing the outer scope produced exactly:

```text
store-open
collector-start
collector-cleanup
store-close
```

The collector's finalizer asserted that the store was still open. This confirms the proposed Layer ownership form without a custom Scope or timer. It does not prove real daemon shutdown, filesystem cleanup, or disable fencing; those remain implementation tests.

## Chosen proposal and alternatives

Recommend a persisted operator opt-in rather than silently activating every existing retention declaration. Applying existing policies after enable keeps the already-approved policy source and newest-version rules. A per-artifact automatic flag would require republishing old identities before they participate; an application-level flag would make maintenance depend on whichever revision happened to be active. Both are feasible alternatives but add authoring semantics to a repository maintenance choice.

A scheduled user workflow calling a new reclamation service is also possible. It would add an author-facing administrative capability and couple maintenance to run/revision availability. A scoped daemon maintenance loop reuses the existing operational authority and avoids that additional public API.

The proposed mode does not automatically delete final versions, daily keys, report/run history or revisions. It therefore improves ordinary version retention without promising bounded total repository storage. That limitation, the first-access protection window, and automatic cursor expiry must be visible in the approval discussion.

## Existing reclamation baseline — repository tests rerun

While the public proposal was awaiting a user decision, the following existing tests were inspected and rerun against the current checkout. This is evidence for the mechanisms the proposal would reuse, not evidence that an automatic collector exists.

```sh
bun test packages/platform-bun/test/lake-retention.test.ts packages/platform-bun/test/artifact-reader-contract.test.ts
bun test packages/platform-bun/test/artifact-reader.test.ts
```

Both commands passed on 2026-11-06: **29 tests, zero failures, 190 assertions across three files**. The first command ran 20 tests in 6.72 seconds; the second ran nine tests in 3.39 seconds. Logs are `/tmp/automatic-retention-baseline-tests.log` and `/tmp/automatic-retention-reader-tests.log`.

The inspected assertions establish these reuse boundaries:

- [lake-retention.test.ts](../packages/platform-bun/test/lake-retention.test.ts) verifies captured-policy changes only on new publication, newest-version preservation, age/count OR semantics, ranking across schema versions, alias isolation, daily-key selection, and protected producers. Apply rechecks policy and ranking after the plan was created.
- The same file tests both sides of an injected unlink failure, resumes cleanup through another SQLite connection, and verifies an identical new publication prevents deletion of its shared blob. These are fault-injection tests, not process-kill tests.
- A metadata-transaction fault rolls back tombstones, receipt and unlink intent together. Applied receipts remain replayable after plan expiry. Collection invalidates query/version cursors and preserves monotonic history.
- [artifact-reader.test.ts](../packages/platform-bun/test/artifact-reader.test.ts) creates a reclamation plan before a consumer reads the reference. The read pins it and applying that older plan deletes nothing. The pin survives Waiting and a new lake handle; after consumer completion, a fresh plan can reclaim it. A query alone creates no pin.
- The reader tests cover all four unsettled report states (`WaitingSource`, `Queued`, `Running`, `NeedsAttention`), release at terminal report states, the 1,024 external-pin limit, and SQLite contention. These tests drive report-state transitions directly; they do not exercise a future background collector racing real report admission.
- [artifact-reader-contract.test.ts](../packages/platform-bun/test/artifact-reader-contract.test.ts) checks the 1,025-version report-source exemption for both run reports and workflow-invocation reports, atomic hold rollback and projection rebuild. These real storage assertions complement the simplified protection boolean in the traversal model.

No production or test source was changed for this baseline. No full-suite or new typecheck result is claimed for this documentation-only turn. Automatic setting races, persisted traversal, lease/shutdown behavior, background contention, diagnostics and backup/restore remain the new implementation's proof obligations. In particular, disable followed immediately by enable must invalidate an old batch through the setting generation even though the boolean has returned to true.

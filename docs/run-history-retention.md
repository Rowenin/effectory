# Reclaim completed run history

Run reclamation removes execution history for completed source runs and all their reports. It leaves artifact content alone and keeps compact records that prevent old submission keys from running again. This is explicit offline maintenance, separate from automatic artifact retention.

Stop the daemon and preview the exact families to retire:

```sh
effectory daemon stop
effectory run reclaim plan --completed-before 2026-10-01T00:00:00.000Z
# Or select one submitted root:
effectory run reclaim plan --run RUN_ID

effectory run reclaim apply PLAN_ID
effectory run reclaim inspect RUN_ID
# Optional: reclaim reusable SQLite pages as file space.
effectory run reclaim compact
effectory daemon start
```

The commands use the existing `--repository` and `--json` options. They never stop or start a daemon implicitly, execute a task, or acquire application Layers. An active repository owner causes Conflict (exit 5). Stop it before retrying.

A date preview can also use `--target TARGET_ID`. Selection uses the latest completion in the entire family, including later report generations. Each plan contains at most 100 eligible families, oldest first. When `hasMore` is true, apply and preview again. This bounds output and memory, not total scan time. Large histories can take time.

Every source and report run must be terminal, report obligations settled, and outbox/recovery work finished. Unfinished families and legacy families without reliable completion evidence are protected. An explicit `--run` bypasses age only. A report-run ID is refused with its source ID so the whole family stays together.

Plans expire 15 minutes after planning finishes. Apply checks exact family membership and completion facts; a later report retry invalidates the plan. Repeating an accepted apply resumes its durable cleanup, or returns the original receipt even after expiry. Keep the plan ID if the connection or process is interrupted.

## What is removed

Retirement removes inputs, outputs, events, logs, checks/JUnit data, waits, recovery details, report Markdown/data and report search records. It also removes the selected native workflow results and clocks through Effect's storage API. **Report regeneration ends permanently for that family in this store history.** Export any report or JUnit document you need before applying.

Ordinary run/report reads then return NotFound with an inspect hint. Historical wait, cancel, recovery and report mutations return Conflict. Lists omit retired families, and old history cursors expire. Other principals receive no retirement information.

`run reclaim inspect` returns the compact run identity, root family, target, revision, terminal status and timestamps. Private storage also keeps the original submission key and fingerprint. Retrying that key returns Conflict even with identical input; use a new key only when you deliberately want another execution. These compact records do not expire, so reclamation reduces payload volume rather than bounding all database growth.

Artifacts, lake identities, digests and bytes remain. Reader pins from unfinished consumers and unfinished report protection remain authoritative. Compact terminal facts let artifact retention distinguish a retired producer from an unexplained missing producer. Schedule last-run/status links keep working. Revision bundles, credentials and vault storage are unchanged.

## Recovery, backup and disk space

An interrupted apply leaves a durable intent and a private pending marker. The next maintenance command or daemon startup finishes that exact intent before any engine, application Layer or background worker starts. Recovery failure prevents readiness. Do not remove maintenance files manually.

Backup refuses pending retirement without opening the source database. Finish recovery, stop the daemon, and retry backup. A completed backup includes the compact records and apply receipts; restore does not allow retired keys to run again. Restoring an older backup restores that backup's older history and deduplication state.

Logical deleted-row counts and estimated payload bytes are not physical disk savings. `compact` checkpoints and vacuums only the run database, reporting actual checkpointed file sizes before and after. Interruption can leave the previous file size; retry safely. SQLite journal/intent writes and compaction need free space, so a full disk may require freeing unrelated space first.

This release upgrades a private admission-storage column that earlier hosts require. Earlier hosts therefore refuse the upgraded database before admission; use a compatible build and keep an offline backup before upgrading. Retained revision ABI compatibility remains a separate restriction: this feature does not migrate saved application bundles between host builds.

See the [approved contract](run-history-retention-api-draft.md), [storage inventory](run-history-retention-storage-audit.md) and [implementation evidence](run-history-retention-implementation.md).

# Run-history reclamation storage audit

Status: **design evidence, not an implementation or user approval**, 2026-11-06. This audit supports the [pending proposal](run-history-retention-api-draft.md). Only scratch databases were mutated. No production source changed and no repository data was reclaimed.

## Current schema, exercised rather than inferred

A scratch program initialized the real `createStore` and `createLake` against an in-memory database and a temporary blob directory. SQLite introspection found **50 tables and 11 triggers**. It captured each table's columns and foreign keys plus trigger SQL. Source: `/tmp/effectory-checks-research/retirement-probe/inventory.ts`; output: `inventory.json` beside it. Temporary storage was removed.

Most host foreign keys use `NO ACTION`, not cascading deletion. In particular, deleting a report generation requires first deleting `host_report_search` and `host_report_search_tags`. Deleting a source requires its report generations, groups, sources and plans to be resolved in dependency order. Disabling foreign keys is not an acceptable shortcut.

The inventory also exposed a missing table in the draft's deletion checklist: `host_report_paths`. Its insert triggers derive path projections from events and task invocations; there is no matching delete trigger. A second scratch program submitted and completed a real host run, then deleted its events. Both derived path rows remained. The retirement manifest must remove these projections explicitly.

## Disposition inventory

| Storage | Reclamation disposition |
| --- | --- |
| `host_runs`, `host_run_tags` | Capture compact identity/fingerprint/terminal facts, then remove detailed rows/tags after dependents. |
| `host_invocations`, `host_workflow_invocations` | Capture native root/leaf execution ids before removal; delete workflow-boundary/path metadata. |
| `host_events`, `host_report_paths`, `host_telemetry_budget`, `host_checks`, `host_check_budget` | Remove all selected-family diagnostics and projections explicitly. |
| `host_waits`, `host_receipts`, `host_cancellation_receipts` | Capture minimal retired-target mappings, then remove historical payloads/receipts. |
| `host_fences`, `host_outbox`, `host_attempts`, `host_attempt_windows` | Require terminal/quiescent eligibility and no pending outbox work; remove selected-family records. |
| `host_recovery_holds`, `host_recovery_gates`, `host_recovery_generations`, `host_recovery_gate_obligations` | Require no unresolved continuation; retain retired-target mapping, then remove family recovery history. |
| `host_report_search_tags`, `host_report_search`, `host_reports` | Remove in this order. Report deletion's trigger removes the matching `lake_report_holds` projection; verify it rather than relying on an assumed foreign key. |
| `host_report_groups`, `host_report_sources`, `host_report_plans` | Remove after generations and their lookups; cover all root/task/workflow scopes. |
| `host_report_receipts`, `host_report_cancellations` | Resolve subjects from the manifest before removing source/group/report records; remove whole-family administration history. |
| `lake_consumer_pins`, `lake_pin_cleanup` | Remove pins belonging to retired terminal consumers. Preserve every unrelated consumer's pins, including pins on this family's artifacts. |
| `host_schedules`, `host_schedule_history`, `host_schedule_receipts` | Preserve; resolve retired run links through compact terminal facts. No schedule generation/watermark change. |
| `host_page_secret`, `host_recovery_clock`, `host_report_rotation`, `host_report_scan`, `host_scheduler`, `host_daemons`, SQLite sequence state | Preserve shared secrets, counters, scan watermarks and daemon administration. Do not reset ids or alter unrelated work. Scan positions must tolerate removed rows. |
| Other `lake_*` tables | Preserve artifact identities/content, query indexes, policy state, automatic retention state and reclamation/install receipts. |
| Native message/reply storage | Clear only manifest root/leaf workflow and clock addresses through Effect MessageStorage; preserve unrelated cluster state. |
| Vault database, revision bundles, extension state, credentials | Outside run reclamation. |

This is a current inventory, not a promise that future tables need no review. A regression should enumerate the initialized schema and require an explicit disposition for newly introduced run-owned tables.

## Artifact protection has several entry points

`lake-protection.ts` intentionally treats a missing producer as protected. The scratch dependency probe used an actual terminal host run and a synthetic lake metadata row: protection was false with the completed run present and true after the host row was removed. That behavior is correct for unexplained missing history today; retirement must add positively verified terminal compact records instead of changing the missing-run default.

All paths must agree: `versionProtection` supplies explanation/counts, `versionIsProtected` supplies worker checks, and `lake-reclamation.ts` also selects producer status directly in its candidate query. Updating only the display helper would leave automatic collection or selection wrong. The private lookup must consistently distinguish live terminal, live unfinished, legitimately retired terminal, and unexplained missing/corrupt identities. Foreign consumer pins remain authoritative.

Probe: `/tmp/effectory-checks-research/retirement-probe/dependencies.ts` and `dependencies.log`. It tests current storage behavior with scratch rows, not a hypothetical compact-record implementation.

## Recovery must precede the whole host Layer

`ownedHostLayer` composes the interpreter, engine, storage, revision catalog, runner, scheduler and automatic artifact collector. Recovery cannot be installed as another sibling Layer: memoization shares dependencies but does not order unrelated acquisitions, and the catalog builds user Layers.

Run retirement recovery explicitly under repository ownership **before constructing/building `ownedHostLayer`**, using storage-only Layers. Only after it succeeds may revisions, native workflows or either background worker start. The existing startup call site is in `daemon.ts` before the runtime Layer is built; non-daemon `hostLayer` callers need the same ordering.

## Non-mutating backup requires a durable marker

The existing binary installation check in `backup.ts` inspects staging directory entries without opening the state database. Retirement needs the same property. Recommended internal ordering:

1. Acquire repository ownership; create a private retirement-pending marker and fsync the file and containing directory **before** committing any retirement intent or compact record.
2. Commit the intent, perform repeatable cleanup and commit its completed receipt.
3. Remove the marker only after all recorded retirement intents have completed; fsync its directory.
4. A crash before intent commit can leave a harmless marker. Startup/repeated maintenance checks SQLite, proves no work is pending, then removes it. A crash after commit always leaves a marker until durable completion is established.
5. Backup reads marker existence and refuses while it is present. It neither opens SQLite to investigate nor attempts recovery. A stale marker therefore refuses conservatively until maintenance/startup resolves it.

The marker is private mechanics, not another user command or an authorization token. A malformed marker fails closed. Tests must kill at every marker/transaction boundary and compare source file inventories and WAL/SHM contents after refused backup. External manual deletion of maintenance files is not a supported recovery procedure.

## Correction to the earlier engine research

The current pinned `ClusterWorkflowEngine` calls `clearClock` on its interrupt path. The earlier research statement that ordinary completion attempts this cleanup was too broad. The offline probe therefore explicitly clears both clock addresses; it does not rely on successful completion having removed them. Root/task address enumeration and persistent clock cleanup remain implementation gates.

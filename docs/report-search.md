# Find reports across runs

`report search` finds stored report records across source runs, including waiting or queued records that have not become report runs. It reads metadata; it does not execute reporters or load application code.

```sh
effectory report search
effectory report search cost --workflow deploy --tag team=platform
effectory report search --workflow deploy --task upload --scope invocation
effectory report search --status Failed --status Cancelled
effectory report get <report-id>
```

The optional text is a literal, case-insensitive substring of the attachment, reporter, source target or root target ID. It does not search Markdown, data, errors, tags or invocation paths. Exact ID filters are case-sensitive. Unknown IDs return no matches.

| Filter | Selects |
| --- | --- |
| `--run ID` | Source root run, including report records without an executing report run |
| `--workflow ID` | Root workflow, including task-invocation reports inside it |
| `--source-workflow ID` | Reported workflow itself, either root or child; mutually exclusive with `--task` |
| `--task ID` | Reported task, either a direct task run or a workflow invocation |
| `--reporter ID` | Reporter task |
| `--attachment ID` | Attachment |
| `--scope run\|invocation` | Source scope |
| `--status STATUS` | One of WaitingSource, Queued, Running, NeedsAttention, Succeeded, Failed, Cancelled, NotApplicable; repeat for an OR set |
| `--tag KEY=VALUE` | Source root's stored tags; repeat to require every tag |
| `--created-after`, `--created-before` | Inclusive report-generation creation time, not source admission or completion |

Filters combine with AND, except the repeated status values. By default, all statuses except NotApplicable are included. Use `--status NotApplicable` to find excluded reports explicitly. Search returns exit 0 even when a matching report failed; `report get` and `report wait` keep their existing outcome exit codes.

## Generations and ordering

Default search picks the latest generation of each source/invocation/attachment group before applying any filter. If a retry failed, `--status Succeeded` does not fall back to its earlier success. Use `--history` to include every generation.

Rows sort by generation creation sequence, newest first. Retrying last month's report can put it first. `root.acceptedAt` shows source admission time; `settledAt` shows report settlement time. An older generation is not returned just because it falls within a creation-time filter when its latest generation does not.

Each row contains report metadata, source identity and root kind/target/tags/admission time. It omits report content, errors and execution policy. Use its `reportId` with `report get` for details.

## Continue through pages

The default page limit is 50, with a maximum of 200 and a 2 MiB encoded page cap. Each request also has a bounded search-work budget. Any combination of filters can return a short or empty page with a non-null cursor. `scanLimited: true` means work or candidate-metadata limits ended the page. A byte-limited page can also have fewer than the requested number of items, with `scanLimited: false`.

**Continue until cursor is null, even when items is empty.** Human mode prints a complete Bash/zsh continuation command to stderr for every non-final page. `--json` writes only the compact page to stdout. Scripts pass the cursor with the same filters and limit:

```sh
effectory report search cost --workflow deploy --limit 50 --cursor '<cursor>' --json
```

The first page fixes a watermark: later runs and retries do not change generation membership halfway through the traversal. Statuses stay live. A report whose status changes after its position was passed is not revisited; start a new search to refresh. Cursors expire one hour after the first page and are bound to the principal, normalized filters and limit. Changing that scope gives Conflict (exit 5); malformed cursors give InvalidInput (exit 2).

Unlike run history and lake queries, report search uses continuation rather than QueryBudgetExceeded for ordinary search-work exhaustion. This lets a no-match search over a long history finish.

## Upgrade and limits

The CLI requires daemon capability `reports.search.v1` before sending a search. Restart a compatible build if the daemon lacks it. Using `--source-workflow` additionally requires `reports.workflow-invocations.v1`. Existing report commands are unchanged.

Startup atomically builds or catches up the search indexes before the daemon becomes ready. This adds disk use and startup time proportional to report history and tags; the implementation's 250,001-generation storage test took about 12.5 seconds to backfill on one machine. It is a measurement, not a time guarantee. `daemon start` allows two minutes for readiness and directs you to the daemon log/status if startup takes longer. The daemon may still be migrating after that CLI timeout.

Search does not prune history or alter backup limits. The extra indexes count toward repository storage and existing backup size limits. Report retention remains a separate feature.

This search preserves historical reports per run. It does not add Swamp's current-report-per-owner dashboard, current-definition label filters, configured behavior instances or interactive picker. Source tags are historical metadata, not report-definition labels.

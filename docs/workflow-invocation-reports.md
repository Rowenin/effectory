# Report on each child workflow

Attach an ordinary reporter task to a workflow with `scope: "invocation"`:

```ts
Report.make({
  id: "region-summary",
  target: Region,
  scope: "invocation",
  task: Summary,
});
```

`Region` is a workflow and `Summary` is a task whose input uses `Report.sourceOf(Region)` or `Report.Source`, and whose success uses `Report.result(...)`. Register the attachment through `Application.make({ reports })`. The [complete example](../examples/workflow-reports/effectory.ts) produces a region report while the deployment waits for approval.

Each actual workflow invocation gets one report, including nested workflows and keyed fan-out. Inactive branches create none. A directly submitted Region also matches. The default workflow scope remains `"run"`; separate attachments in both scopes intentionally produce two reports for a direct submission. Selection and required attachments work as for task reports.

Reports start when that child settles, without waiting for its parent. Source task retries and workflow replay keep the same report identity. Report retries create a new generation using the same source and pinned revision. Reporting never changes the source outcome.

An empty workflow can succeed without any task attempts. A child activated but stopped before entry gets NotApplicable/NotStarted. A completed child's cached outcome wins over a later parent cancellation. A child interrupted by a sibling's failure is Cancelled with a `stoppedBy` explanation, never assigned the sibling's domain error.

## History

Yield `Report.History` inside the reporter or a task-local Layer. For workflow-invocation reports:

- `outcome(Region)` returns that child's typed result or failure.
- `invocations()` lists task invocations in its subtree, including nested descendants and patches.
- `events()` includes attributed child events, publications, wait settlements and deadlines. It excludes siblings and parent lifecycle events. Run-wide TelemetryTruncated remains visible because child telemetry may be missing too.

Root workflow invocations see the whole root. Existing run-scope and task-invocation reports retain their root-wide view. This is a reporting scope, not an access restriction on ArtifactReader.

Follow each history cursor until null, **including after an empty page**. Pages have fixed membership, live invocation status, and the existing item/response limits. Scoped traversal stops after 10,000 examined rows, 16 MiB of attribution data or 250 ms of cooperative work. Original event sequence numbers remain; gaps are normal. A matching oversized event still fails LimitExceeded; oversized sibling event bodies are not read.

`Report.test` takes the same fixtures as before. For a child source, provide already-scoped task/event arrays. Host integration tests, rather than fixtures, verify actual subtree attribution.

## Find and manage reports

```sh
effectory workflow run deployment --input '"us-east"' --background
effectory report search --workflow deployment --source-workflow region --scope invocation
effectory report wait --report <report-id>
effectory report get <report-id>
effectory report retry <report-id> --request-key retry-1
```

`--workflow` selects the submitted root. `--source-workflow` selects the reported workflow itself, either root or child. It cannot be combined with `--task`. Unknown IDs return no matches. The CLI checks `reports.workflow-invocations.v1` before using the new filter; restart a compatible daemon when needed.

Pending child reports keep the root's publications protected under the existing retention rules. Report admission still has four slots and per-source fairness. Wide fan-out can queue many reports; `report cancel --run <source-run-id>` remains the bulk escape. No historical attachment plans are retroactively changed.

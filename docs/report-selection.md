# Selecting reports

Select report attachments when submitting a task or workflow. The source still runs normally and keeps its own exit code; reporting remains separate work.

```sh
effectory workflow run deploy --report deployment-cost
effectory workflow run deploy --report-tag category=cost
effectory workflow run deploy --skip-report deployment-cost
effectory workflow run deploy --skip-report-tag category=cost
effectory workflow run deploy --skip-reports
```

Supply the workflow's usual input alongside these flags. The same flags work on `task run`, including `--background`. Names identify **attachment IDs**, not reporter task IDs. `workflow describe`, `task describe`, and `workflow plan` show the applicable attachments, their tags and whether they are required.

Repeat name flags to select any of those IDs. Repeat tag flags to require every supplied `KEY=VALUE` pair; duplicate keys are invalid. Matching is exact and case-sensitive. Inclusion names and inclusion tags must both match when combined. Either exclusion family wins over inclusion for optional reports. Unknown or irrelevant IDs fail before admission; unmatched tags are valid.

`--skip-reports` skips all optional reports and cannot be combined with other selectors. **Required reports remain selected under every filter.** Required does not force a branch to execute or override the attachment's `on` outcomes. It does not prevent report cancellation, guarantee success, or make the source wait for reporting.

## Authoring

Add classification and optional selection immunity to an existing attachment:

```ts
const Category = Tag.make("category", Schema.Literals(["cost", "audit"]));

const audit = Report.make({
  id: "deployment-audit",
  target: Deploy,
  task: AuditDeployment,
  tags: [Category("audit")],
  required: true,
});
```

This fragment assumes the imports and target/reporter definitions. Register the attachment through `Application.make({ reports: [audit] })`. See the executable [reports example](../examples/reports/effectory.ts) for a complete application with an optional classified attachment.

Classification accepts typed bindings or an encoded string map, using the existing run-tag limits. Bare tag definitions are invalid. These labels do not enter `Tag.Values`, publication tags, or `report search --tag`, which still filters source-run tags.

Schedules accept the same selection using `Report.Selection`:

```ts
const nightly = WorkflowSchedule.make({
  id: "nightly-deploy",
  workflow: Deploy,
  input: deployInput,
  cron: "0 2 * * *",
  reportSelection: { onlyTags: [Category("audit")] },
});
```

This fragment assumes `Deploy`, `deployInput`, and `Category`. The fields are `only`, `onlyTags`, `skip`, `skipTags`, and `skipAll`. Unknown schedule attachment IDs reject the application revision before reconciliation. Selection, classification and required-only edits preserve schedule generation, watermark and pending occurrence. The next admission captures the observed revision's decision.

## Captured decisions and retries

`run get` includes `reportSelection` for new ordinary runs: the normalized `requested` selector and sorted `selected`, `excluded`, and `required` attachment IDs. Lists and watch summaries omit it. Older runs have no recorded decision; absence does not imply a reconstructed default.

Candidates include the root's run-scope attachments and task invocation attachments reachable through branches, fan-out, children and patches. Direct task runs include both scopes. Child-workflow boundary reports remain unsupported.

Excluded attachments create no report record or retention hold. They cannot later be retried into existence: submit a new source run to choose differently. Selected attachments still use normal outcome filtering and report retries.

Reuse the same request key with the same normalized selectors after uncertain delivery. Reordered or repeated IDs normalize identically; empty selectors retain the previous no-selector fingerprint. A changed choice conflicts. Receipt lookup happens before loading current definitions, so a deployment removing an attachment does not invalidate an already accepted request.

Explicit flags require daemon capability `reports.selection.v1`; unsupported daemons are refused before submission. Restart a compatible daemon. Commands without selection flags retain their previous compatibility. The input and selector share the existing 1 MiB HTTP request limit; at most 128 candidate attachment IDs are captured.

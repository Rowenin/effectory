# Report selection at admission — proposal 1

Status: researched against the current source and pinned Swamp. **User-approved, implemented and verified.** See [implementation evidence](report-selection-implementation.md). The user approved this public contract after the feasibility checks. This is not a claim of independent reviewer approval. Report search is already implemented and verified; this is the next parity feature.

## Consumer goal

An operator running a deployment should be able to suppress optional expensive reports, request a particular report, or select a category. An author should be able to keep an audit report enabled despite those filters. Existing runs, retries and scheduled catch-up must keep their captured choice.

Report selection controls which attachments become report obligations. It does not change the source task/workflow, its result, its exit code, the attachment's outcome filter, or the separate report queue.

## Proposed authoring surface

Add two optional fields to `Report.make`:

- `tags?: Tag.Input`: a frozen classification map using existing typed bindings or an encoded string map. These are attachment metadata, not source-run tags. Bare tag definitions are invalid because a classification needs a value. Existing RunTags key/value/count/4096-byte limits apply.
- `required?: boolean`: defaults to false. A required attachment survives all operator selection filters. It still obeys its scope, `on` outcomes and existing source eligibility. It is not an execution-success guarantee or an authorization boundary: cancellation remains possible and reporter failures remain separate from the source result.

Illustrative additions to an otherwise existing application; the fields are now implemented:

```ts
const Category = Tag.make("category", Schema.Literals(["cost", "audit"]));

const CostReport = Report.make({
  id: "deployment-cost",
  target: Deploy,
  task: EstimateCost,
  tags: [Category("cost")],
});
const AuditReport = Report.make({
  id: "deployment-audit",
  target: Deploy,
  task: AuditDeployment,
  tags: [Category("audit")],
  required: true,
});
```

The target and reporter declarations follow the existing Report API; this snippet assumes those definitions and imports. Attachment IDs remain application-unique. Registering/removing attachments remains `Application.make({ reports: [...] })`; no second author-side skip registry is added. The same reporter can have differently classified attachments.

`Tag.value()` continues to read the source run's inherited tags when a reporter executes. Classification tags do not enter that service, its publications, or `report search --tag` (which continues to mean source-run tags).

## Operator selection

Both `task run` and `workflow run` accept:

```sh
effectory workflow run deploy --report deployment-cost
effectory workflow run deploy --report-tag category=cost
effectory workflow run deploy --skip-report deployment-cost
effectory workflow run deploy --skip-report-tag category=cost
effectory workflow run deploy --skip-reports
```

`--report` and `--skip-report` name **attachment IDs**, not reporter task IDs. They are repeatable OR sets. `--report-tag` and `--skip-report-tag` are repeatable `key=value` pairs; each map is an AND predicate. Duplicate keys are rejected, consistent with existing tag flags. Matching is exact and case-sensitive on the stored encoded strings. There is no glob or label-expression language.

For example, two `--skip-report-tag` flags for `category=cost` and `team=finance` suppress only attachments matching both. Multiple name filters select any listed name. If names and inclusion tags are both supplied, an optional attachment must match both families. Exclusion by either an explicit name or the complete exclusion tag map wins over inclusion. Required attachments survive both families.

`--skip-reports` means skip all **optional** reports. Reject combining it with any other report-selection flag as InvalidInput; it would otherwise make the other flags redundant. CLI help and the foreground report hint state that required reports remain. With no flags, behavior is unchanged.

Unknown or irrelevant attachment IDs fail before run admission with InvalidInput (CLI exit 2), naming the IDs and pointing to the target's describe command. Tag predicates that match nothing are valid: only required attachments remain. No input/request receipt is created for a refused selection.

### Candidate universe

Validation uses the submitted root's possible execution graph, including both branches, keyed fan-out templates, linked child workflows and compiled before-step patches. It is not a prediction of which branch will execute. Only root run-scope attachments plus invocation-scope attachments for reachable task identities qualify. A directly submitted task has its existing run- and invocation-scope candidates. A child workflow's own run-scope attachments still do not execute as child-boundary reports; that remains a separate gap.

Walk the compiled graph with existing `Workflow.allNodes`, following child definitions through the registry with a visited set. Match canonical task identity/version as the existing report registry does. Do not execute handler code, input-dependent conditions or fan-out items while selecting.

Today `reportPlan` captures all application invocation attachments, even unrelated ones; only later invocation registration makes that harmless. Narrowing the captured candidates is needed for useful unknown-name validation and changes no actual default report execution.

### Selection precedence

1. Determine applicable candidates from the pinned root graph and attachment scope.
2. Retain every required candidate.
3. For optional candidates, remove everything if skipAll is true.
4. Otherwise exclude explicit skip IDs or complete skipTags matches.
5. Apply the optional inclusion ID set and inclusion tag map, if nonempty.
6. When a selected source actually settles, apply existing `on`, NotStarted and NoNativeExecution rules.

A required audit with `on: ["Succeeded"]` still does not run for a failed source. Selecting an attachment on an inactive branch does not make that branch run. The same choice applies to every invocation of a selected task attachment in that source run.

## Request, schedule and inspection shapes

The normalized RPC payload adds an optional `reportSelection` to TaskRun and WorkflowRun:

```ts
type EncodedSelection = {
  readonly only?: readonly string[];
  readonly onlyTags?: Readonly<Record<string, string>>;
  readonly skip?: readonly string[];
  readonly skipTags?: Readonly<Record<string, string>>;
  readonly skipAll?: boolean;
};
```

Each ID array permits at most 128 IDs using the existing 200-character author identifier grammar (ASCII letters/digits followed by letters/digits/dot/underscore/slash/hyphen). Normalize arrays as sorted unique sets; empty arrays/maps and skipAll false are omitted. No-op selection is equivalent to absence. Selection consumes part of the existing 1 MiB RPC request-body budget along with the input and envelope; this proposal does not raise that limit. Use Effect Schema and the existing tag schema, with excess-property rejection and no author codec execution during request normalization.

Export a `Report.Selection` authoring type with the same fields, but `onlyTags` and `skipTags` accept `Tag.Input`. `WorkflowSchedule.make` adds `reportSelection?: Report.Selection`:

```ts
WorkflowSchedule.make({
  id: "nightly-deploy",
  workflow: Deploy,
  cron: "0 2 * * *",
  timeZone: "UTC",
  input: {},
  reportSelection: { skipTags: [Category("cost")] },
});
```

This is illustrative proposed syntax; Deploy/input must match the actual workflow. Constructor validation copies and freezes selection data; application registration validates IDs against the compiled root graph. Invalid scheduled selectors fail application loading with DefinitionError. No new service, Layer, Scope or custom Effect combinator is needed: selection is pure data resolved before admission, and existing task/report lifetimes remain the owners of execution.

`task describe` and `workflow describe` expose the complete possible candidate list with attachment ID, reporter, scope, tags, required and outcomes. Workflow plan reports the same candidates, including inactive branches. Schedule inspection shows its normalized selection.

### Excluded reports and durable explanation

**Recommendation for user approval:** filter the captured report plan before arming. Excluded attachments create no per-invocation report rows or retention holds. This avoids producing up to 160,000 NotApplicable rows simply to say an optional report was suppressed, and does not extend the existing NotApplicable reason enum for old clients.

Instead, new source runs have an optional additive `Run.reportSelection` audit field:

```ts
type SelectionDecision = {
  readonly requested: EncodedSelection;
  readonly selected: readonly string[];
  readonly excluded: readonly string[];
  readonly required: readonly string[];
};
```

The lists contain sorted attachment IDs from the candidate universe. `required` is a subset of `selected`. Capture this decision even for default/no-candidate submissions on the new host, so `run get` is the durable explanation. Keep it out of RunSummary/list/watch snapshots to avoid repeating up to 128 attachment IDs in every snapshot. Background and foreground submission replies include it because they return Run. With valid normalized candidate IDs, selected and excluded partition at most 128 candidates, required repeats at most 128, and the requested only/skip lists each hold at most 128. A conservative 128 KiB bound covers the complete decision including both 4096-byte tag maps. Enforce that internal bound on persisted decisions; keep it out of history-page accounting by omitting the field from RunSummary.

No report ID exists for a selection-excluded attachment, and `report retry` cannot bring it back. Submit a new source run with different selection. Existing outcome exclusions for selected attachments still produce NotApplicable records and retain existing retry semantics. `report search` continues to search actual records; it does not synthesize selection exclusions. This is a public tradeoff, not an implementation detail.

## Durability and compatibility

- Keep `lookupSubmission` before revision loading. Normalize only the request's encoded selection first, include it in the manual request fingerprint when nonempty, and repeat the existing receipt check inside the insert transaction. Do not include resolved attachment defaults or current metadata in that fingerprint. An identical retry returns its old Run/decision even after the app changes or a selected ID is removed. Reusing a request key with different normalized selection returns Conflict (exit 5).
- Resolve candidate graphs, tags and selection outside SQLite. Insert the source, selected immutable plan, decision and dispatch outbox in one host-store transaction. A fault must roll back all of them. No new execution engine or cross-connection transaction.
- Existing plans decode missing attachment required/tags metadata as false/empty if those fields are captured for description. Do not recompute existing runs against the active revision. Runs without the new audit field mean the decision was not recorded; do not invent an empty selection.
- Schedules capture the selected plan and decision from their observed revision. Selection-only or attachment classification/required edits behave like current report-plan edits: they preserve schedule generation, watermark, pending occurrence and request key. Existing admitted runs remain unchanged; the next successful admission captures the observed choice. Keep the new selection/decision data out of the scheduling identity digest and scheduled submission fingerprint. A failed pre-reconcile validation must leave the installed schedule state untouched.
- Add capability `reports.selection.v1`. CLI with any explicit selection flag checks it before TaskRun/WorkflowRun, including background mode. No-flag commands continue to work with old daemons. Old readers ignore the new optional Run field; new readers accept its absence. Prove these using actual schemas/HTTP paths rather than assuming unknown keys are uniformly ignored.
- Existing Task/Report.test APIs are unchanged: report selection is an admission feature, not reporter handler input. Unit-test selection with real registry fixtures and verify the operator path through real daemon tests.
- Required is selection immunity only. It does not prohibit report cancellation, force a source branch to execute, change report wait precedence, or make foreground submissions wait for reports. No change to source exit codes.

## Swamp comparison and evidence

Source reviewed locally at vendored commit `b42dd1ac63c899e1cba75efae9d7d3dd1ce96c11`; no upstream integration suite was run.

- `vendor/swamp/src/cli/commands/workflow_run.ts:247–266` and `model_method_run.ts:311–331` expose name/label inclusion and exclusion, plus skip-all.
- `vendor/swamp/src/domain/reports/report_execution_service.ts:70–143` contains candidate/required/filter precedence; its tests cover required immunity, name and label filters. Names and labels both supplied act as intersecting inclusion families; labels within one family match any label.
- There is a source/document discrepancy: skipAll returns early, before definition-level skip and method restrictions, despite the comment/design saying definition skip always wins. Do not reproduce that accidental branch. Effectory has no second definition skip registry in this proposal.
- Effectory uses application-unique attachment IDs, optional attachments by default, existing typed key/value tags and conjunctive tag maps. Swamp uses report names, free-string labels, behavior defaults and require/skip lists. These are deliberate public differences. A key/value tag map cannot represent multiple values of the same key; use separate keys for independent classifications.
- Swamp workflow-scope candidates originate in require, which makes its operator filters ineffective on those required reports. Effectory optional-by-default attachments make the same operator control useful for workflow reports too.
- Selecting or requiring an unregistered reporter is not dynamic loading here: existing Application validation still rejects missing/noncanonical reporter tasks before a revision activates.

Current integration points: `core/report.ts` and `report-registry.ts`; `platform-bun/report-plan.ts`; `runner.ts` submission; `host-store.ts` fingerprints/atomic capture; `report-sources.ts` source arming; `scheduler.ts` and `schedule-store.ts` observed plans; runtime Submit/Run schemas; CLI run flags and capability preflight.

Scratch proof: `/tmp/effectory-report-selection-probes/selection.ts` uses the real Application registry, Workflow graph, current reportPlan and real Tag bindings. It confirms the current unrelated-invocation capture and shows reachability narrowing on a simple graph. Existing Tag normalization freezes bindings and rejects bare definitions. A labelled stand-in selector passes eight precedence cases. **This does not test the proposed API, TypeScript inference of its new fields, persistence, schedules, or real admission.** Log: `selection.log` alongside the probe. A second probe subsequently covered the complete nested/patch graph and old response-schema decoding; see [additional feasibility evidence](report-selection-evidence.md). No production code was changed.

## Implementation proof gates after approval

1. Real constructor/type tests for tags, required and scheduled selection; wrong values/bare definitions/foreign bindings/duplicate keys/oversized input rejected, captured maps immune to caller mutation.
2. Complete reachable candidate traversal: direct task both scopes, linked children, branches, fan-out and compiled patches, unrelated targets refused, missing targets fail clearly. Describe/plan and admission use the same candidate resolver.
3. Precedence matrix: defaults, every flag, combined names/tags, include-and-skip conflict, required immunity, on/outcome exclusion, no matches, exact encoded strings, invalid combinations and unknown IDs.
4. Real daemon proves selected reporters run, excluded reporters never arm or acquire retention holds, source outcome unchanged, audit explains exclusions, and excluded reports cannot be retried into existence.
5. Atomic capture failure, lost reply, repeated request key, normalized no-op/backward fingerprints, changed selection Conflict, new revision with removed IDs returning the original receipt, and restart preserving the stored decision.
6. Scheduled tag/required/selection-only edits preserve generation and pending catch-up; new admission gets the observed plan while earlier admitted runs retain theirs. Invalid selectors fail before reconcile mutation.
7. Old-daemon refusal before submission, old Run decoding, legacy plan decoding, untouched reason enums, and the maximum decision size fitting its 128 KiB bound, omission from summaries, and request-size rejection before admission when selection plus input exceeds the existing 1 MiB HTTP body limit.
8. Report task/Vault/ArtifactReader lifetimes and source retention remain governed by selected obligations; cancellation/bulk cancellation/report retry remain compatible. No report recursion.
9. Typecheck, lint/format and the full repository suite on a stable source tree. Earlier 409-test results precede this feature and cannot count as its implementation evidence.

## Approval

The user approved the package: typed attachment classification and required immunity; five CLI flag families with the stated precedence; the same selection on schedules; graph-scoped ID validation; and exclusion before report-row creation with the decision visible in run get. The main user-visible tradeoffs are that skip-all keeps required reports and an excluded attachment has no report record to retry. Implementation follows the user approval; verification is tracked separately.

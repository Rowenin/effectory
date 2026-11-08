# Run tags — revision 3, SUPERSEDED AUTHORING SHAPE

The user requested typed callable tag definitions, arrays of bindings, and heavy reuse of Effect primitives. [The typed-tags revision](run-tags-typed-api-draft.md) is under review and supersedes this document's authoring shape. The storage, scheduling, filtering and compatibility decisions below remain the baseline unless explicitly changed there. Neither proposal has user approval for implementation.

Proposal only. No production code or exports have been changed for this feature. The Claude Effect and consumer reviews have cleared presentation after the corrections recorded below. User approval is still required before implementation. Snippets are proposed and have not been typechecked.

## Why this is the next parity slice

Attach business labels to a run, inspect/filter its history, read those labels in a task, and carry them into produced artifacts. Typical labels are `env`, `team`, `deployment` and an external correlation ID. Existing run IDs, principals and structured schedule occurrence metadata retain their current meanings.

Pinned Swamp evidence:

- `vendor/swamp/src/cli/commands/workflow_run.ts:242` accepts repeatable `--tag KEY=VALUE` and describes propagation to produced data.
- `vendor/swamp/src/domain/workflows/execution_service.ts:3665` merges workflow tags with runtime overrides and creates the run with that merged map.
- `vendor/swamp/src/domain/models/model.ts:254` exposes `MethodContext.runtimeTags`.
- `vendor/swamp/src/cli/commands/workflow_run_search.ts:234` accepts tag filters for run search.
- `vendor/swamp/src/domain/models/data_writer.ts:1245` overlays workflow and runtime tags onto output tags. Swamp runtime tags beat code-declared model/method output tags, but per-step `dataOutputOverrides` are applied afterward and win (`data_writer.ts:1250–1267`). This proposal lets explicit publication options override inherited labels.

Effectory currently has publication tags and lake tag queries, but no run tags in submission, history, task context or schedule configuration. The occurrence feature adds structured scheduling provenance only.

## Consumer API

```ts
// PROPOSED; not typechecked.
import {
  Application,
  RunTags,
  Task,
  Workflow,
  WorkflowSchedule,
} from "@effectory/core";
import { Effect, Schema } from "effect";

const Inspect = Task.make(
  {
    id: "inspect-run",
    version: 1,
    input: Schema.Null,
    success: RunTags,
    error: Schema.Never,
    replay: "idempotent",
  },
  (_, context) => Effect.succeed(context.tags)
);

const Report = Workflow.make(
  {
    id: "report",
    version: 1,
    input: Schema.Null,
    success: RunTags,
    error: Schema.Never,
    tags: { team: "platform", env: "dev" },
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    return yield* graph.task("inspect", Inspect, null);
  })
);

const Hourly = WorkflowSchedule.make({
  id: "hourly-report",
  workflow: Report,
  input: null,
  cron: "0 * * * *",
  tags: { env: "prod", source: "hourly" },
});

export default Application.make({ tasks: [Inspect], schedules: [Hourly] });
export const fixture = Task.test(Inspect, {
  input: null,
  tags: { env: "test", deployment: "deploy-42" },
});
```

```sh
# PROPOSED
# Effective run tags: team=platform, env=prod, deployment=deploy-42.
effectory workflow run report --input null --tag env=prod --tag deployment=deploy-42 --background
# Direct task runs have no workflow defaults.
effectory task run inspect-run --input null --tag env=prod --background
effectory run list --tag env=prod --tag deployment=deploy-42 --json
```

No service requirement, new Layer, handler parameter, graph node or workflow input field is added. Tags are metadata; domain values that require a workflow's input validation still belong in input.

## Public surface, exhaustively

1. Export `RunTags` as a named Effect Schema from `@effectory/core`, also through `@effectory/core/RunTags`. Exact forms are `import { RunTags } from "@effectory/core"` and `import { RunTags } from "@effectory/core/RunTags"`; both are the same Schema value. A namespace import from the subpath is a module object, not the schema. It lives in a schema-only leaf importing `effect`; runtime protocols import that public leaf subpath directly. There is no separate internal export. No new `Run` service or namespace is introduced. Its decoded type is `typeof RunTags.Type`, a readonly string record.
2. Add optional readonly `tags` to `Workflow.Spec` and the `WorkflowSchedule.make` spec. Omitted means no defaults/overrides. Expose the captured map as required readonly `Workflow.Definition.tags` and `WorkflowSchedule.Definition.tags`, always present and frozen (`{}` when omitted). The former is workflow defaults; the latter is schedule overrides. Constructors synchronously validate/copy these maps; the host reads only the captured definition fields. `Workflow.spec` keeps its existing identity, so inspecting or mutating the original spec is not how consumers read or update captured defaults. Preserve generic inference, codec identities and all Task spec identity behavior. No `tags` field is added to `Task.Spec`.
3. Add required readonly `tags` to the handler's `Task.TaskContext`; it is always a frozen map, including `{}`. Keep `Task.RuntimeContext.tags` optional for low-level callers constructing contexts. `Task.execute` validates a present low-level `RuntimeContext.tags`, normalizes absence to a fresh empty frozen map, and captures publication inheritance from that snapshot. Present undefined or a malformed map fails `TaskRuntimeError` / `InvalidBoundary` before the handler. It is not part of `Task.Identity`.
4. Add optional `tags` to `Task.test(task, { input, occurrence?, tags? })`. Decode strictly and lazily on evaluation, before the handler. Omission yields `{}`; a present `undefined` is invalid, matching occurrence fixtures. Each evaluation captures its own frozen copy. Invalid fixtures use `TaskRuntimeError` / `InvalidBoundary` with a bounded field-specific message. Service requirements and input inference remain unchanged.
5. Add readonly `tags: Readonly<Record<string, string>>` to `Task.TestPublication`, showing the effective publication metadata. This map has publication-tag semantics, not the narrower RunTags key/count/value rules.
6. Add optional `tags: RunTags` to `WorkflowRun` and `TaskRun` RPC payloads. Existing request keys, revision selectors and input fields keep their meanings.
7. Add required decoded `tags: RunTags` to `Run` and `RunSummary`. New servers always encode this field, including `{}`. For compatibility with old daemons, a missing encoded key decodes to a fresh `{}`; present undefined/null/invalid maps fail. Use a key-only decoding default with passthrough encoding (the `Schema.withDecodingDefaultKey` behavior), not an optional decoded field or an encoding omission. Get, list, foreground results and watch snapshots agree. No event-log duplication of the full map is required. The missing-key default exists only for decoding RPC replies. Host projections (get, list, watch snapshot, foreground result) read the backfilled non-null tag column and decode it with RunTags directly, or use a strict internal schema requiring tags. A projection that forgets the column must fail rather than report `{}` for a tagged run.
8. Add optional `tags: RunTags` to `RunListRequest`, as an exact-match conjunction: every requested key/value must exist and match. Missing differs from an empty string. Omitted and `{}` both mean no tag filter. Existing kind/target/status/time filters combine with AND.
9. Add repeatable `--tag KEY=VALUE` to both run-submission commands and `run list`. No new top-level command or `run search` alias.
10. `workflow describe` and `workflow plan` add `tags` containing captured workflow defaults, with `{}` for none. Their documentation explicitly says these defaults apply when this workflow is submitted as the root, not when it is a linked child. Neither command accepts run-specific tag overrides in this slice. `schedule get` adds `tags` containing the effective merged map that a newly admitted run would receive. The added typed `ScheduleDescription.tags` field uses the same missing-key decoding default and always-present server encoding as Run tags, so an old scheduling daemon remains readable. Schedule list/history shapes otherwise remain unchanged; admitted history links to run IDs for tag inspection.
11. Publication through `context.publish` automatically inherits run tags. Existing explicit `options.tags` overrides inherited keys for that publication only. An empty override map does not clear inherited tags. No opt-out/deletion syntax is introduced. `Task.test` uses the same merge and reports the effective tags in its publication records. Run tags have a 4096-byte budget within the existing 8192-byte publication budget, leaving room for explicit output labels.
12. Add a `run-tags.v1` capability. The CLI must check it before sending nonempty tag submissions or tag filters, so an older server cannot silently ignore a new field. Existing untagged commands and run reads continue to work against an old daemon through the missing-key decode rule. Empty tag maps are omitted from outgoing CLI payloads, including RunList (whose old host rejects unknown filter keys). A nonempty tagged operation is refused with an actionable restart/upgrade message before submission/filtering, rather than silently losing its intent. A daemon without run-tags.v1 also does not apply authored Workflow.make default tags: its runs report `{}` and publish without inherited labels until restarted on this build. An old WorkflowSchedule.make rejects the new tags option rather than applying it.

## Tag schema and limits

At most 32 own string keys. Keys follow `^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$`. Values are strings of at most 256 UTF-16 code units; empty strings are allowed. The canonical JSON encoding of the entire map must be at most 4096 UTF-8 bytes. All constraints apply after default/override merging as well as to each supplied map. Invalid keys must be rejected, never silently stripped by Schema.Record parsing.

Use Effect Schema at all boundaries. The selected schema construction is `Schema.Record(Schema.String, Value).check(Schema.isPropertyNames(Key), Schema.isMaxProperties(32), byteBudget)`, where Value checks the 256-unit limit and Key checks the ASCII pattern with the `u` flag. Do not put the refined key schema in Schema.Record itself: Effect silently drops invalid keys in that shape under default RPC decoding. Key validity must not depend on caller-supplied excess-property options.

The generated JSON Schema must contain `propertyNames.pattern`, `maxProperties: 32`, and a string-value schema with `maxLength: 256`. A mere pattern with `additionalProperties: true` is insufficient. The UTF-8 byte budget is decoder-only. JSON Schema maxLength counts Unicode code points, whereas Effect counts UTF-16 units, so supplementary characters also make JSON Schema a looser approximation; Effect decoding is authoritative. A flat map's JSON byte length is independent of key order, allowing the leaf to use TextEncoder/JSON.stringify without importing Buffer or core execution helpers.

Non-JSON authoring, fixture and low-level context values such as Date/Map are not supported tag maps; those entry points preflight the original object before record decoding so they fail rather than becoming `{}`. A Record schema alone normalizes those prototypes away, as the [scratch probes](run-tags-schema-probes.md) show. This preflight is distinct from the JSON wire schema; JSON RPC values cannot contain those prototypes. No trimming, case folding, Unicode normalization or interpolation occurs. Key ordering is insignificant. Definition/fixture copies must not retain caller-owned objects.

Tags cannot set principal, actor, revision, status or occurrence metadata; those remain separate fields. Tags are exposed as run/publication metadata and are not an authorization mechanism. There is no reserved system-tag namespace in this slice because the system does not encode its own identity in this map.

CLI parsing splits on the first `=`: `--tag correlation=a=b` stores `a=b`. Missing `=` or invalid keys/values fail with exit 2 before submission. Duplicate CLI keys are rejected, including identical repeated pairs, rather than silently choosing one. `--tag env=` is a valid empty value. Shell quoting handles spaces. RPC maps naturally represent one value per key.

## Defaults, overrides and durable identity

A manual workflow submission resolves the selected root workflow's defaults, then overlays submission tags. A scheduled workflow overlays schedule tags onto its root workflow defaults. Direct task submissions use only submission tags. There is no additional caller override on scheduled admission.

Linked child workflows, branches, fan-out, replacement implementations and before-step patches inherit the host run's final map. A linked child's authored defaults do not create a nested scope or change the parent's run tags. This deliberately differs from Swamp's nested workflow tagging, where the child contributes its workflow tags (consumer reviewer's partial source trace); Effectory children remain inside one host run. Running that child as a new top-level workflow uses its defaults normally. Task handlers get a fresh frozen copy per attempt, and replacing a local context property cannot change a sibling, retry, persisted map or publication inheritance.

Store the final map with the run in the admission transaction. Do not recompute it from current source during execution or inspection. Accepted runs retain their tags through edits, cancellation, waits and restart within the same host build.

Manual submission fingerprints include the normalized caller-supplied tag map, not the merged defaults. Omitted and `{}` are equivalent and use the original untagged fingerprint shape, preserving existing untagged request-key receipts. Nonempty supplied tags become an additional fingerprint field. Keep the same normalization in both `lookupSubmission` and the actual insert transaction. Lookup precedes resolving current definitions: retrying the same submission after source defaults change returns the original run and tags. Changing supplied tags under the same key is Conflict, even if the merged result would happen to be equal.

Schedule tags are metadata, like description. Store the effective merged map in the schedule configuration, but exclude tags entirely from the schedule digest. A tag-only change preserves generation, watermark and pendingSlot, including catch-up across a deploy/restart. Existing untagged digests remain byte-for-byte unchanged. Missing stored configuration tags decode to `{}`; a present invalid map fails Unavailable. Cadence/input/policy/workflow-version changes and removed/re-added schedules retain their existing generation semantics.

Reconciliation updates the stored effective map and observed revision without restarting the schedule. New admissions, including retries of an unadmitted pending slot, use that stored map after reconciliation. They do not consult live source during the admission transaction. A failed admission that committed no run has no immutable tag receipt yet; it may therefore receive newly reconciled labels on retry, with the same occurrence key. Once a run is admitted, later edits never change it. Scheduled fingerprint identity excludes these metadata labels; they are not caller-supplied submission tags.

Constructor/merge errors are explicit: invalid authored maps throw DefinitionError. WorkflowSchedule.make also validates the merged workflow-default/override map synchronously, using captured Workflow.Definition.tags. Manual submission validates its merged map after dedup lookup and before admission; overflow/invalid tags fail InvalidInput. Task.test and low-level RuntimeContext validation fail lazily with TaskRuntimeError / InvalidBoundary.

## Publication and lake behavior

Run tags flow to task publication as `{ ...runTags, ...publicationOptions.tags }`. Explicit artifact labels win because they describe that output. Swamp runtime tags beat code-declared output labels, while its per-step output overrides win last. Effectory gives the task author that final override through publication options. A task's hard-coded `env` can therefore differ from the run's `env` in lake queries; document this explicitly. Authors who want run labels to win can supply `tags: { kind: "summary", ...context.tags }`.

Keep the existing publication tag boundary for the merged result (string values and at most 8192 canonical JSON UTF-8 bytes). Existing publication keys and artifact identity do not change. The effective tags participate in the existing publication fingerprint; retrying one publication key with changed effective tags remains PublicationConflict. Publishing a new artifact version from another run can have different tags, as today. Neither run tags nor tag filters deduplicate runs or artifacts.

Merge and validate inside core contextFor before calling runtime.publish; both Task.test and production then use one path. Non-string publication values fail TaskRuntimeError / InvalidBoundary. A merged map over 8192 bytes fails TaskRuntimeError / LimitExceeded before bytes or metadata are committed, with a message identifying inherited plus explicit publication labels as the cause. The lake retains its existing check as defense in depth. The test harness must enforce this same merged tag limit so a passing Task.test does not promise an invalid production publication. Existing publication tag keys are not retroactively restricted to the new run-tag grammar. `context.publish(..., { tags: {} })` inherits the run labels; consumers needing a per-artifact difference explicitly override that key. Removing an inherited key is deferred.

Existing lake queries already support exact tag predicates and need no new query syntax. Verify inherited labels via the existing lake query/get/versions operations; run history filters do not scan the lake.

## History, compatibility and storage

Tag filters participate in the signed history cursor scope after normalizing omitted/empty maps and sorting keys. Changing any key/value invalidates the cursor; reordering keys does not. Retain the existing owner authorization, fixed admission membership and live status semantics. Tags themselves are immutable. Keep existing page/scan/byte limits, including explicit QueryBudgetExceeded; no partial success or unbounded fetch-all filtering. Tag predicates must be evaluated in SQLite before the page scan budget is counted. Use an index-backed tag lookup so a rare correlation ID remains searchable in a repository with more than 10,000 other runs; every tag predicate (conjunction) is evaluated in SQL, so only rows satisfying all tag predicates, plus the existing SQL time and cursor predicates, are yielded to and counted by the existing scan and byte budget. Parameterize keys and values: neither is SQL or a JSON-path fragment. Tests cover the query plan or equivalent evidence of indexed lookup as well as the large-history result. Existing kind/status filters may still reject overly broad queries under their documented budgets. Tags count toward the 16 MiB scanned-JSON budget, so large tag maps can make an unfiltered history query reach its byte limit before the 10,000-row limit; narrow its filters/time range if that occurs.

Add tag storage deliberately as the first bounded additive host-store migration, under exclusive ownership; backfill absent run tag metadata to `{}`. Preserve any existing refusal of unsupported older layouts. This metadata-only step does not migrate retained execution bundles. An invalid present stored map fails the existing Unavailable boundary rather than being dropped, normalized or skipped. Do not claim this provides execution migration for retained bundles from another host ABI; that remains unsupported. Validate get/list/watch projection consistency and unchanged untagged idempotency receipts during the storage upgrade.

Decoded output maps are always present. Encoded tags are optional for old-response decoding only; new-server passthrough encoding always includes them. This is a public contract change and needs approval. The capability requirement prevents a new CLI from successfully submitting tag-bearing intent to an old server that drops unknown payload fields. Direct RPC consumers must negotiate the capability too. Plain untagged submissions, old manual request keys and existing publication identities retain their behavior.

## Proofs required before declaring implementation complete

1. Positive/negative types for Workflow tags, schedule tags, context readonly fields and Task.test fixtures; input, success, error and service inference remain intact. RunTags can be a task success schema.
2. Authoring, fixture, RPC and stored-row probes reject malformed maps and unsupported keys instead of dropping them. Confirm 32-key/64-key-character/256-value-unit/4096-byte run limits, the separate 8192-byte publication limit, empty values, Unicode byte accounting, explicit undefined, raw Date/Map preflight, default-option bad-key rejection and JSON Schema propertyNames/maxProperties exports.
3. Captured defaults/overrides cannot be mutated by callers. Context copies are frozen and isolated across attempts, linked children, both branch choices, fan-out, providers and patches. Untagged manual runs expose `{}`. Child defaults are ignored only when linked into another host run.
4. Manual and scheduled merges match the stated precedence. Tag-only changes preserve schedule generation, watermark and pending slot; catch-up still admits after a tag-only deploy. A pre-upgrade untagged pending schedule keeps its digest and occurrence request key. Old admitted runs retain their map after reconciliation and restart.
5. Lost-reply retries preserve tags and dedup before loading changed defaults. Different supplied maps conflict. Omitted/empty requests and historical untagged fingerprints remain equivalent. Cover the transaction's second dedup check too.
6. Run get/list/watch and foreground results agree. Filter conjunction, empty versus missing, all existing filters, principal isolation, cursor binding/reordering, concurrent admissions and bounded scanning have tests. A repository with more than 10,000 untagged runs and one matching tagged run returns that run without QueryBudgetExceeded. Old run/list/watch/schedule-description responses without tags decode as `{}`; present malformed maps still fail. A host projection omitting the stored tag column must fail its test rather than receive the client compatibility default.
7. Publication inheritance, explicit override, the operator-wins spread idiom, empty overrides retaining labels, unchanged key identity, conflict behavior and byte-limit failures have task-harness and real lake tests, including versioned query results. A maximal 4096-byte run map plus a small explicit label succeeds; oversized merged maps fail LimitExceeded in both paths.
8. CLI parsing and error exits, uncertain-delivery retry keys, JSON output and old-server capability refusal have integration tests. An untagged submission to a capability-less fake server succeeds and decodes a reply without tags as `{}`, with no refusal. A real daemon restart retains the same map and artifact labels.
9. Regenerate the host module table for the schema export. Required checks: `bun run typecheck && bun run check && bun test`. Use an isolated source snapshot if other sessions are still editing shared runtime/CLI files.

## Explicitly deferred

Mutating tags after admission; tag removal or per-publication opt-out; Task-spec default tags; conditional/computed tag expressions; tag inheritance scopes for linked child workflows; OR/wildcard tag search; label-based access control; retroactively tagging existing artifacts; generic host ABI migration; MCP and external trigger APIs. No production implementation starts before user approval.

## Round-1 review resolution

Both Claude reviews conditionally approved presentation after fixes. Revision 2 applies the consumer fixes: mandatory indexed SQL tag filtering, non-generational schedule labels, a 4096-byte run limit and backward-compatible missing-output-key decoding. It also applies the Effect schema construction, captured Definition.tags fields, precise constructor/merge/publication errors, shared core publication validation, exact named import forms and legacy schedule-config decoding. The Swamp precedence description now includes final step overrides; linked-child default handling is named as a deviation.

Two choices deliberately differ from the Effect review's preferred fixes: old untagged daemons remain readable through a key-only decoding default rather than a blanket capability refusal, and tags never enter the schedule digest rather than entering it only when nonempty. The default-key/passthrough behavior was verified against Effect 4.0.5 in a scratch probe: absence produces `{}`, explicit undefined/null/wrong values fail, and encoding always includes tags. The focused Effect round-2 review accepted both decisions. Revision 3 applies its remaining F1–F3 corrections: client-only compatibility defaults with strict host projections, disclosure of old-daemon default-tag behavior, full SQL conjunction before budget counting and explicit tag-byte accounting. Both reviewers said no further round is required after their specified fixes. No public implementation is approved.

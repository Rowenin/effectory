# Run tags — Effect review, round 1

Reviewer: Claude, from the Effect perspective. Target: revision 1 of `docs/run-tags-api-draft.md`. I compared the draft with the current `packages/core`, `packages/runtime`, `packages/platform-bun` and `packages/cli` source, and with the pinned `vendor/swamp` citations. I also ran scratch probes against `effect@4.0.5` using `bun -e` from the repository root. The probes wrote no files. The only file I created is this review.

This review does not approve implementation. Reviewer approval is not user approval. No production code has changed.

**Verdict: CONDITIONAL APPROVE FOR PRESENTATION.** The design fits the engine, and most of the draft's assumptions about the existing code hold. Three blockers, B1 to B3, change the public contract or upgrade behavior. Each one has a small, exact text fix. Four clarifications, C1 to C4, also need one or two sentences each. Once those edits are applied, the draft can be presented to the user. I do not need to see another round unless an edit changes direction.

Labels: **[fact]** means I checked it in source or with a probe. **[inference]** means reasoning I did not test. **[untypechecked]** marks example code I did not compile.

## Assumptions verified against source

| Draft assumption | Status | Evidence |
| --- | --- | --- |
| Swamp citations | **[fact]** correct | `workflow_run.ts:242` defines the `--tag` collect option. `execution_service.ts:3665` builds `mergedTags = {...workflow.tags, ...runtimeTags}`. `model.ts:254` is `runtimeTags?` inside `MethodContext` (interface at line 154). `workflow_run_search.ts:234` defines `--tag` filters. `data_writer.ts:1245–1250` applies `runtimeTags` last, so runtime wins. The draft describes the precedence difference accurately. |
| Lookup happens before definitions are resolved | **[fact]** | `runner.ts:222` calls `store.lookupSubmission` before `catalog.get`. `host-store.ts:481` runs the second dedup check inside the insert transaction. Both build the same `canonical({input, kind, revision, targetId})`, so "omit when empty" keeps the existing fingerprint bytes. |
| Run tags survive execution and restart without recomputation | **[fact]** | `leafLayer` reloads the run on every leaf with `store.getRun(runId)`, and `taskContext(run, …)` builds the context from the stored row (`interpreter.ts:64–104`). The engine payload is only `runId`. A stored `tags` column is therefore the single source of truth, as the draft requires. |
| Linked children, branches, fan-out and patches inherit the host map | **[fact]** | `ChildNode` and patch graphs run inside the same run, and `allNodes` and `PatchCompiler` work within one run. Inheritance needs no extra plumbing. |
| The publication fingerprint already includes tags | **[fact]** | `lake.ts:208–213` computes `canonical({digest, schemaId, schemaVersion, tags: options.tags ?? {}})`. The harness computes `canonical({tags: publication.tags ?? {}, value})` at `task.ts:280`. Because both normalize `undefined` to `{}`, existing untagged publications keep their fingerprints when run tags are `{}`. |
| Existing publication tag byte limit | **[fact]** | `lake.ts:194` checks `Buffer.byteLength(canonical(options.tags ?? {})) > 8192` before `atomicBlob`. Neither the core boundary nor `Task.test` validates tags today: no string-value check and no byte check. String values are enforced only later, by the `ArtifactRecord` decode inside the transaction. The draft is right that the harness must gain this check. |
| Schedule digest and generation | **[fact]** | `schedule-store.ts:318–361` hashes `Configuration` without `description`, and a digest change bumps the generation and resets the watermark and `pendingSlot`. The scheduled `requestKey` is `hash({generation, scheduleId, scheduledFor})`. |
| A capability list exists | **[fact]** | `control-plane.ts:174` returns static `capabilities` in `ServerHello`. `client.ts:60` calls `SystemHello` but never reads `capabilities`, so the CLI check is new client work. It is feasible because the hello response is already available. |
| An old server ignores the new payload field | **[fact, probe]** | A default `Schema.Struct` decode drops unknown keys: `{runId, tags}` decodes to `{runId}`. The capability gate on submissions is therefore justified. |
| Host-provided core | **[fact]** | `host-modules.generated.ts` maps `@effectory/core*` to the host's own copy. A merge placed in core always runs the host build's code. |

## Blockers

### B1. A required `tags` field in outputs breaks the claim that existing untagged commands keep working

The draft makes `tags` required on `Run` and `RunSummary` (item 7). It then says that "existing untagged commands continue to work" and limits the capability check to non-empty submissions and filters (item 12).

**Counterexample [fact, probe].** Effect RPC decodes success values on the client. A new CLI decoding an old daemon's `Run` fails with `Missing key at ["tags"]`. As a result:

- `run get`, `run list` and `run watch` all fail against an old daemon.
- A plain, untagged `workflow run` is admitted by the old server, but the CLI then fails to decode the reply. The user sees a failure for a run that exists. That is exactly the uncertain-delivery case the capability gate was meant to prevent.

Version skew is real here. `serverVersion` is hard-coded, and nothing refuses a mismatched daemon.

**Smallest fix (pick one; I recommend (a)):**

- **(a)** The CLI requires `run-tags.v1` before calling any RPC whose success type contains `Run`, `RunSummary`, a watch frame, or a schedule or workflow description that carries `tags`. Without the capability it exits before sending anything, with "daemon does not support run tags; restart it with this build". Replace "Existing untagged commands continue to work" with that rule. Direct RPC consumers that decode with the new schemas must check the same capability.
- **(b)** Keep `tags` as `Schema.optionalKey` on the wire and normalize a missing value to `{}` on the client. This weakens item 7, so I do not prefer it.

### B2. The schedule digest must keep its untagged shape; stored configuration must decode with tags absent

The draft promises that omitted-versus-empty tags do not change the generation, and that the storage upgrade preserves untagged receipts. It does not say how the digest input or the stored `Configuration` change.

**Counterexample [fact + inference].** Suppose `tags: {}` is always added to `Configuration` and to the digest identity. On the first reconcile after upgrade:

- Every existing untagged schedule gets a new digest, so `generation` increments, the watermark resets to `now` and `pendingSlot` is cleared (`schedule-store.ts:342–361`).
- Any pending admission retry is lost, and future scheduled request keys change.
- Separately, `config(row)` decodes `definitionJson` with a required `tags` key. Until reconcile rewrites a row, that decode fails, which affects `schedule get` and admission.

**Smallest fix.** Add this text: "The schedule digest includes `tags` only when the effective map is non-empty, so untagged schedules keep their pre-upgrade digest and generation. The stored `Configuration.tags` is an optional key that decodes as `{}` when absent; a present invalid map fails `Unavailable`." Add one acceptance test: an untagged schedule database from before the upgrade, with a `pendingSlot`, keeps its generation, slot and request key after upgrade.

Related precedent [fact]: `createStore` currently refuses older `host_runs` layouts outright (`host-store.ts:128–150`, the `admissionNamespace` check). This would be the store's first additive in-place migration (a nullable `tagsJson` read as `{}`). The draft should say that this is deliberate.

### B3. `RunTags` must not use a refined `Schema.Record` key schema

The draft forbids silently stripping invalid keys but leaves the construction open. The obvious construction strips them on every non-strict decode path, including RPC payloads and stored rows.

**Probe [fact], `effect@4.0.5`:**

| Construction | Input | Result |
| --- | --- | --- |
| `Schema.Record(KeyPattern, Value)`, default decode | `{ok:"a","-bad":"b"}` | `{"ok":"a"}` (**stripped**) |
| same, decoded from `JSON.parse('{"__proto__":"x"}')` | — | `{}` (**stripped**) |
| same, with `onExcessProperty:"error"` | `{ok:"a","-bad":"b"}` | rejected |
| same, `toJsonSchemaDocument` | — | `patternProperties` **plus `additionalProperties: true`**, which advertises the wrong contract |
| `Schema.Record(Schema.String, Value).check(Schema.isPropertyNames(KeyPattern), Schema.isMaxProperties(32), bytes)` | `-bad`, `__proto__`, 33 keys, >8192 bytes | all rejected under default options, on both decode and encode |
| same, `toJsonSchemaDocument` | — | `additionalProperties:{type:string,maxLength:256}`, `propertyNames:{pattern}`, `maxProperties:32` |

**Smallest fix.** State the construction explicitly: "`RunTags = Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(256))).check(Schema.isPropertyNames(Key), Schema.isMaxProperties(32), byteBudget)`. Key validity never depends on `onExcessProperty`."

Two notes to add:

- JSON Schema `maxLength` counts code points, while Effect's `isMaxLength` counts UTF-16 units. A probe confirmed that 129 astral characters (258 units) are rejected. The JSON Schema is therefore looser for astral text, and the decoder is the authority, which the draft already allows for.
- For a flat string map, the canonical JSON byte length does not depend on key order. The leaf can use `TextEncoder` on `JSON.stringify(map)` without importing `canonical` or `Buffer`, so it still imports only `effect`.

## Clarifications required (text only)

- **C1. Where frozen workflow tags live.** `Workflow.make` currently stores the caller's `spec` object as-is (`workflow.ts:517`). Freezing a copy does not stop `definition.spec.tags` from aliasing the caller's mutable object. Add: "The captured map is exposed as `Workflow.Definition.tags` (always present, frozen, `{}` when omitted), and the host reads only that field. `spec` keeps its identity." The same applies to `WorkflowSchedule.Definition.tags`, which holds the schedule's override map; the effective map is computed at reconcile. Task spec identity is compared in four places (`application.ts:171`, `extension-registry.ts:163`, `extension.ts:263`, `patch-compiler.ts:31`). This slice leaves `Task.Spec` untouched, so those checks are unaffected, and that should stay true.
- **C2. Error types for the synchronous constructors and for merging.** State the error at each stage:
  - Invalid `Workflow.make` or `WorkflowSchedule.make` tags throw `DefinitionError`.
  - `WorkflowSchedule.make` validates the merged map (workflow defaults plus overrides) at construction, which is possible because the workflow's captured tags are available synchronously.
  - A manual submission whose merged map exceeds a limit fails `InvalidInput` before admission, after `lookupSubmission`.
  - `Task.test` fixtures fail `TaskRuntimeError`/`InvalidBoundary`, lazily, as the draft says.
- **C3. One shared place for merging and validating publication tags.** Put `{...runTags, ...options.tags}` and the publication-tag check (string record, ≤8192 canonical bytes) inside core `contextFor` (`task.ts:125–157`), in its existing `boundary`, before `runtime.publish`. Pass the merged map as `options.tags`. Then `Task.test` and the host share one code path automatically, and `TestPublication.tags` is just the `options.tags` the harness receives. The lake check stays as defense in depth.
  - Specify the failure codes: an oversized map fails `TaskRuntimeError` `LimitExceeded`, matching the lake. A non-string value fails `InvalidBoundary`.
  - In `execute`, also decode a present `RuntimeContext.tags` with `RunTags` and freeze the result. A decoded record is not frozen ([fact, probe]: `Object.isFrozen` → false). Treat a malformed map from a low-level caller as `InvalidBoundary` rather than forwarding it.
- **C4. Export form.** Every other root export except the two error classes is a namespace (`index.ts`). State the exact import forms:
  - `import { RunTags } from "@effectory/core"` and `import { RunTags } from "@effectory/core/RunTags"` are both named `Schema` values.
  - `import * as RunTags from "@effectory/core/RunTags"` is not the schema.
  - Drop the separate internal subpath. The runtime can import the public leaf because it already depends on `@effectory/core`.
  - Both subpaths go into the host module table.

## Deliberate deviations

| Deviation | Position |
| --- | --- |
| Explicit publication tags beat inherited run tags, unlike Swamp | **Accept.** It is documented, keeps artifact labels local, and does not affect identity. |
| No run-tag service or Layer; tags are a context field | **Accept.** This matches the `occurrence` precedent, keeps `R` unchanged, and avoids a service that would leak into `Application` requirements. |
| `TaskContext.tags` required, `RuntimeContext.tags` optional | **Accept.** Handlers always see a map. Low-level host and test callers that build `RuntimeContext` keep compiling. `make` is the only producer of `TaskContext` [fact]. |
| `Task.test` validates lazily; constructors validate synchronously | **Accept.** This matches the existing occurrence fixture (`test-occurrence.ts`) and the constructors' `DefinitionError` pattern. |
| `TestPublication.tags` uses publication-tag semantics, not `RunTags` | **Accept.** Publication keys keep their existing, wider grammar. Existing repository tests do not use `toEqual` on whole publication records [fact], so the new field breaks nothing in the repository. |
| Manual fingerprint covers supplied tags, not merged tags; omitted equals `{}` | **Accept.** I verified that the byte shape is preserved. |
| Effective tags in the schedule digest | **Accept, with B2.** |
| Mandatory `tags` in outputs | **Accept only with B1.** |

Note, not a blocker: a run whose tags use most of the 8 KiB budget will cause any publication with additional explicit tags to fail `LimitExceeded`. The draft accepts this; it is worth one sentence in the user-facing summary.

## Example check

[untypechecked] The consumer snippet matches the current API shapes: `Task.make(spec, handler)`, `Workflow.make(spec, Effect.gen(...))`, `graph.task(id, task, input)`, `WorkflowSchedule.make({id, workflow, input, cron})`, and `Application.make({tasks, schedules})`, which discovers `Report` through the schedule (`application.ts:77–85`). `RunTags` satisfies `Boundary` (`Codec<unknown, unknown, never, never>`), so it can serve as a task success schema. With `noUncheckedIndexedAccess`, `context.tags.env` has type `string | undefined`, which is correct. The precedence comments in the shell example are correct.

## Acceptance tests to add (beyond the draft's list)

1. B1: a new CLI talking to a fake server whose hello lacks `run-tags.v1` refuses `run get`, `run list`, `run watch` and an untagged `workflow run` before sending, with no admitted run.
2. B2: a pre-upgrade untagged schedule row with `pendingSlot` keeps its digest, generation, pending slot and next request key across upgrade and reconcile. A stored `definitionJson` without `tags` decodes as `{}`.
3. B3: RPC payload, stored row and fixture decodes, each under default options, reject `-bad`, `__proto__` and 33 keys. The generated JSON Schema contains `propertyNames.pattern` and `maxProperties: 32`, and does not contain `patternProperties` with `additionalProperties: true`.
4. C1: mutating the caller's `tags` object after `Workflow.make` or `WorkflowSchedule.make` changes neither `definition.tags`, nor `workflow describe`, nor the schedule digest.
5. C3: the same oversized merged map fails `LimitExceeded` in `Task.test` and in a real lake publish, and no lake record is committed. A handler that spreads `context` and replaces `tags` still publishes with the original inherited map.

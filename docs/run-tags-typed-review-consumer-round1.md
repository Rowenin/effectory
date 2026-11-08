# Typed run tags — consumer review, round 1

Reviewer: Claude, as the consumer-DX review subagent. Subject: [run-tags-typed-api-draft.md](run-tags-typed-api-draft.md), revision 1, with the storage and semantics baseline in [run-tags-api-draft.md](run-tags-api-draft.md). Review only. I made no production edits, no commits and spawned no subagents. Reviewer approval is not user approval.

## Verdict

**Request changes before presenting to the user.** Most of the shape is good: callable bindings in arrays, `Config` as the reader, `ConfigError` carrying the key, and no schema DSL. Three items need fixing before presentation, and the doc needs to state one tradeoff honestly:

- **C1:** `.config` lets a handler silently read the daemon's environment.
- **C2:** every handler repeats the same error-mapping boilerplate.
- **C3:** "stronger type" stops at admission. The draft currently presents this as acceptable. It should be put to the user as a choice, with a small, non-global alternative recommended.

## Evidence

**Checked in source** (pinned `node_modules/effect` 4.0.5 and repo source):

- `Config.Config<T> extends Effect.Effect<T, ConfigError>`. When it is yielded, it evaluates against `fiber.getRef(ConfigProvider.ConfigProvider)` (Config.ts:113–136).
- The default `ConfigProvider` reference is `fromEnv()` (ConfigProvider.ts:351–354). `packages/platform-bun/src` never installs a provider for handlers. The only reference is the module table entry (host-modules.generated.ts:37).
- `Config.schema` wraps decode failures as `ConfigError(SchemaError(Pointer(path, issue)))` (Config.ts:1314–1330). `ConfigError.message` is `cause.toString()` (Config.ts:76–92).
- `Task.make`'s handler error channel is `S["error"]["Type"] | TaskRuntimeError` (task.ts:175–183). A non-`TaskRuntimeError` failure is re-encoded with `spec.error` and otherwise becomes `InvalidBoundary` / "Task boundary validation failed" (task.ts:112–123, 196–205). So an unmapped `ConfigError` is a compile error, and if it is cast away, the specific message is lost.
- The host already loads the application registry in-process. It decodes `target.inputSchema` for validation (control-plane.ts:136–158) and exports `Schema.toJsonSchemaDocument(target.inputSchema)` for `describe` (control-plane.ts:105–128).
- `Schema.Int` is `Number.check(isInt())`, unbranded (Schema.ts:7963). `Schema.Literals`, `Schema.NonEmptyString`, `Schema.isGreaterThanOrEqualTo` and `Schema.toCodecStringTree` all exist under the names the draft uses. The checked Effect files (index/Context/Effect/Schema) export nothing named `Tag`.

**Scratch runtime probe** (file under the session scratchpad, run with bun against pinned Effect, not committed):

- `Config.schema(String→StringTree(Literals(["dev","prod"])), ["env"]).parse(fromUnknown({ env: "garbage" }))` fails with a message containing `Expected "dev" | "prod"` and `at ["env"]`. Key context is present.
- `Config.all` failed only on the first bad key (`env`), not on the bad `shard`. It fails fast and does not aggregate.
- With `process.env.env = "prod"`, yielding the same Config **directly succeeded with `"prod"` from the process environment**. This is the C1 footgun, confirmed at runtime.
- `Effect.provideService(cfg, ConfigProvider.ConfigProvider, provider)` works as a standard alternative to `.parse(provider)`.
- A literal dotted key `["a.b"]` read `"7"` as `7`.

**Untested inference (not proven):** `NoInfer` blocking widening on a callable definition; heterogeneous `Binding<K>` arrays inferring cleanly in `Workflow.make`'s `const S`; the quality of hover text and diagnostics; branded schemas requiring `Brand.make` at call sites.

## Findings

### C1 — `.config` is an Effect that reads the daemon environment when yielded (must fix)

The draft says documentation will use `.parse(Tag.provider(context.tags))` consistently. But `Definition.config` is a real `Config`, so `yield* Environment.config` type-checks, and the forced `mapError` looks the same either way. It then returns whatever `env` is set to in the daemon process, or a missing-value failure, and never sees the run's tags. Short keys like `env`, `shard` and `label` are exactly the names that collide with environment variables. This bug fails silently and plausibly, the worst kind for a "stronger type" feature.

Minimal fix: adopt C2. Handlers then never handle a provider, and the only documented read path cannot hit ambient lookup. Also add an explicit warning on `Definition.config`'s JSDoc. Add a required proof that `yield* Def.config` inside a `Task.test` handler does **not** observe the run's tags. That proof records the hazard; it does not endorse it. Do not have the host install the tags map as the ambient provider. Tasks legitimately use `Config` for real environment settings, and layering the two sources (`orElse`) would make collisions worse.

### C2 — Error mapping boilerplate on every read (should fix; also fixes C1)

The documented read path is a provider plus `.parse` plus a hand-written `mapError` to a `TaskRuntimeError` with an invented code and message. Every tag-reading handler repeats it. Since the error is fixed by Task's error channel, the mapping is the same everywhere, which makes it library work.

Smallest fix, one member on the existing context with no Config family:

```ts
// TaskContext (PROPOSED)
readonly readTags: <A>(config: Config.Config<A>) => Effect.Effect<A, TaskRuntimeError>;

// handler
const labels = yield* context.readTags(ReportLabels);
```

Semantics: it calls `config.parse(provider)` on a provider built once per context from the already-validated frozen map (`fromUnknown(..., { preserveEmptyStrings: true })`). It maps `ConfigError` to `TaskRuntimeError({ code: "InvalidBoundary", message: "Invalid run tag: " + bounded(error.message) })`, keeping the key and issue that the probe shows `ConfigError.message` already carries. Users who want a domain error still get one with `Effect.catchTag("TaskRuntimeError", …)`, or by calling `.parse(Tag.provider(tags))` themselves. Keep `Tag.provider` public as the escape hatch for non-handler code. `Task.test` gets the same method automatically through `contextFor`. Choose the member name at implementation; `readTags` reads well next to `tags`.

This is plain reuse: it accepts any `Config`, so `Config.all`, `withDefault`, `option`, `map` and `orElse` all work unchanged.

### C3 — Accepting invalid CLI and raw values until read undermines "stronger type" (must be presented as a user choice; recommend the alternative)

From the consumer's side, what the draft actually delivers is: **typed authoring and typed reads, with untyped admission and history.** Concretely:

- `--tag env=garbage` is admitted, stored and listed. The run then fails partway, possibly after earlier tasks have committed side effects or publications, when some task reads `Environment.config`. For an idempotent-retry system that is the expensive failure mode, unlike exit 2 at submit.
- A raw-map schedule override `{ env: "production" }` passes `WorkflowSchedule.make` and fails at every scheduled run.
- History can contain `env=garbage` permanently, and there is no way to find out which keys a workflow expects.

That is weaker than what a user reasonably expects after writing `tags: [Environment("dev")]`. The draft's own point 10 says as much; it should not go to the user framed as settled.

**Smallest coherent alternative (not global, no implicit registration):** let the root workflow's `tags` array also accept **bare definitions** as declarations, next to bindings as declarations with defaults:

```ts
// PROPOSED alternative
Workflow.make({ ..., tags: [Environment("dev"), Shard, Label] }, ...)
//                    ^ declared + default  ^ declared, no default
```

- **Scope:** only keys declared by that root workflow. Undeclared keys stay free-form metadata exactly as in the draft, so dynamic operator labels keep working. There is no catalog or cross-workflow registry. Tasks and linked children are unaffected. Direct `task run` stays unvalidated because tasks have no tag spec; say so explicitly.
- **Admission:** after the baseline's dedup lookup, the host validates the merged map's declared keys with each definition's `codec` and fails `InvalidInput` with the key and issue. This follows the existing precedent: the host already decodes `inputSchema` in-process (control-plane.ts:145). The CLI still ships no codecs and gets a normal error reply.
- **Schedules:** `WorkflowSchedule.make` validates its override map, typed or raw, against the workflow's declared codecs synchronously, as a `DefinitionError` at construction.
- **Storage:** validate only; store the submitted string unchanged. Fingerprints, exact filters and the `"03"` vs `"3"` behavior stay as in the baseline. Canonicalization is out of scope.
- **Discoverability:** `workflow describe` adds `tagSchemas: { [key]: JSONSchema }` via the existing `Schema.toJsonSchemaDocument`, so operators can see accepted values. That is the main discoverability gap in the draft.
- **Captured shape:** `Workflow.Definition.tags` stays the encoded defaults map. Add one more captured readonly field for declared definitions. It is in-process only and never serialized, consistent with point 12.

**Cost:** one more array-member type, one host admission check, and a describe field. Reads still go through `Config`, so a task reading a key its workflow did not declare still validates late. That residual risk is honest and local.

If the user prefers to keep the draft's late validation, the presentation must say in plain words: "typed when authored in code and when read; the CLI and raw maps are not validated until a task reads the tag." It must also include the partial-side-effects consequence. Either way, the user decides; the reviewer recommends the declaration form.

### Lesser items (fix wording or add proofs; no redesign)

1. **Callable binding arrays: good.** `tags: [Label("billing"), Environment("dev")]` is concise, and duplicate-key rejection plus encoded-map equivalence are right. Using `key` rather than `name` avoids the `Function.name` clash; keep it. Add to the required proofs: a definition is not accepted where a binding is expected. That changes if C3 is adopted, in which case it becomes deliberate for workflow tags only, and overrides, fixtures and publications must still reject bare definitions.
2. **Raw-map escape hatch: keep.** It is needed for dynamic keys, invalid-value fixtures in `Task.test` (the only way to test the read-failure path) and the `{ kind, ...context.tags }` idiom. Document "no mixing" with the fix: wrap a dynamic value as `Tag.make("correlation", Schema.String)`, or use a raw map. Also document that typed publication arrays cannot express the operator-wins spread; the raw map is the way to do that.
3. **Two places for defaults.** A workflow default `Shard(0)` and a reader `Config.withDefault(0)` can drift. Document that reader defaults only matter for direct task runs, untagged schedules or reuse across workflows; otherwise prefer workflow defaults. Note too that `Config.option` and `withDefault` fail on a present malformed value; they do not fall back. The draft says this, but put it in the user-facing examples.
4. **`Config.all` fails fast.** It reports only the first bad tag (probe). Document it, or note it as acceptable. Do not build aggregation.
5. **Value limits.** A 256-unit value makes `Schema.fromJsonString(Struct)` a trap for anything nontrivial. Keep it, but have the binding-time error say "encoded value exceeds 256 characters" with the key, and recommend input or artifacts for structured data. Limits apply to encoded strings; state that in the error, not only in the doc.
6. **Same key, different schemas.** Two `Tag.make("env", …)` definitions disagree silently. With C3 the workflow's declaration is authoritative at admission; without it there is no anchor at all. Recommend exporting one definition per key from a shared module. That is guidance, not enforcement.
7. **Brands.** Branded schemas will need `Shard(Shard.codec.make(3))`-style construction. This is untested; add it to the type proofs and show it in docs if it is awkward.
8. **`Tag.provider` revalidates per call.** That is fine for the escape hatch. With C2 the context provider is built once from the already-frozen map.

## Required doc changes before presentation

1. Add `context.readTags(config)` (C2) and rewrite the consumer sketch and error section around it. Keep `Tag.provider` as the escape hatch.
2. Add the ambient-provider warning and a proof (C1).
3. Rewrite point 10 as an explicit user decision between late validation (the draft) and workflow-scoped declarations (C3, recommended), with the consequences of each.
4. Fold lesser items 1–7 into the contracts and proofs as wording, without adding more API.

No further consumer round is needed if these changes are applied as written. Choosing between C3's two options belongs to the user, not the reviewers.

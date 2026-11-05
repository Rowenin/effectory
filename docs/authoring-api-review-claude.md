# Authoring API review (Claude)

Status: an independent developer-experience review of the five candidates in [authoring-api-options.md](authoring-api-options.md). It does not change that proposal and does not select an API.

**What this review rests on.** Nothing here has been tested. No Effectory implementation exists. No snippet in this file or in the brief has been typechecked. Every statement about inference, autocomplete or where an error appears is a reasoned prediction from how TypeScript and Effect usually behave, not an observation. Statements about Effect's own `Effect.gen` typing rest on established, widely used behavior. Statements about every new Effectory type (`Output<T>`, `Ref`, graph handles, pipeline overloads) are **unproven** until a type-level prototype exists. Rankings are qualitative. I have not invented scores.

## The question underneath the five options

Most of the trade-offs come down to one decision: **can the customer, the CLI or an extension see a workflow's structure before it runs?** Options 3, 4 and 5 say yes and expose the structure honestly. Option 1 says no and stays honest about that. Option 2 says yes, but it uses the same syntax as an executable program.

Three of the stated product requirements depend on visible structure:

- Extension overrides beyond swapping a provider (Question 6).
- "See what will run before starting" (Question 9).
- A queryable lake and agents that read or edit workflow definitions.

If those requirements are real, the workflow language has to be a declaration. If they can be reduced to "replace a task implementation" and "intercept a named call when it is reached", Option 1 is the most pleasant API and should win. **The team should decide that requirement explicitly before picking a syntax.** My recommendation below assumes the requirements stay, because the README and the extension docs present them as core.

## Who the customer is

| Audience | What they write | Does the choice of workflow syntax affect them? |
| --- | --- | --- |
| Workflow author (beginner to Effect) | Workflows, small tasks | Heavily |
| Workflow author (experienced with Effect) | Workflows, tasks, services | Heavily; they will bring Effect habits |
| Task-provider / extension author | `.implement` handlers, Layers | Barely: handlers are `Effect.gen` in every option |
| Extension author who patches workflows | Gates, replacements | Heavily: needs addressable structure |
| Agents and generated workflows | Edits to definitions | Heavily: favors data over code |

Task providers write the same thing in all five options: an `Effect.gen` handler behind a schema contract. That part of the design is good and should stay. The contest is only about the orchestration language.

---

## Option 1: executable Effect program

**Strengths**

- It transfers ordinary skills best. `if`, `switch`, `Effect.forEach`, helper functions and early returns all work, and the values are real decoded values.
- Branching on runtime results (Question 2) is a normal `if (release.prerelease)`. Both branches return values that TypeScript checks against the declared success type. This works with no new vocabulary.
- Approval (Question 3) reads naturally: `const ok = yield* ctx.approve(...)`, and then the code handles denial explicitly.
- Effect's generator inference is a known quantity. Wrong inputs fail at the call argument, and a missing handler appears in `R`. These rest on established Effect behavior, not a new mapped-type trick.
- Debugging feels familiar. Stack traces point at source lines, and you can reason about the order of a run line by line.
- Reusing code (Question 4) means writing a function that takes a key prefix. A child workflow gets a nested scope.

**Objections**

- **It looks like Effect but behaves differently.** An experienced Effect author will use `Effect.sleep`, `Effect.timeout`, `Effect.race`, `Effect.retry`, `Clock`, `Random`, `Deferred` or a service call inside the workflow. Each of these type-checks and works in development. Each can break replay or durability in production. The brief calls this the "most likely mistake". In my view it is the defining property of this option, because experienced users hit it more often than beginners. Durable-execution systems built on replay are known for this class of determinism bug.
- Invocation keys are hand-written strings that the author must keep stable. `` `fetch:${repository}` `` is correct, but `` `fetch:${i}` `` compiles just as well and is unsafe. The type system cannot tell the two apart.
- Question 6 (an extension inserts an approval) is only partly supported. Call interception ("before invocation `publish` is reached, run this gate") would actually satisfy the literal example. The brief undersells this. What Option 1 cannot do is validate the patch before activation, prove that `publish` is reachable, or rewire edges.
- Question 9 (see what will run) is unavailable before a run. Afterwards there is a good record of what actually ran.
- The `R` channel accepts any service. Nothing stops a workflow from yielding `HttpClient` directly.

**What it would need to be acceptable as primary:** a workflow `R` constrained to `WorkflowContext | TaskHandler<…>`, so arbitrary services fail to type-check; durable replacements for timeout, race and sleep, with lint rules banning the in-memory versions in workflow bodies; replay-divergence errors that name the key and show the old and new input fingerprints; and call-site interception as the documented extension mechanism.

## Option 2: Alchemy-style declarative generator

**Strengths**

- It is familiar to Alchemy users, and helpers that `yield*` to register nodes compose cleanly with namespacing.
- It produces a real graph, so it gets the inspection and patching benefits.

**Objections**

- **It has Option 1's syntax with the opposite meaning.** `yield*` usually means "wait for this result". Here it means "register this, return a placeholder". When a reader sees `const release = yield* …` followed by `release.version`, the reasonable expectation is a string.
- The Alchemy precedent transfers less than it appears to. Infrastructure graphs rarely branch on a value produced by an earlier resource during apply. Workflows do so all the time (Question 2, approval outcomes). The option's weakest point is the workflow's most common need.
- `if (release.prerelease)` tests a reference object, which is always truthy. **TypeScript will not report this.** Object types are truthy, and recent TypeScript versions flag only literal always-truthy expressions, not variables. So it is a silent logic bug, not a type error. A type-aware lint rule could catch it. That rule does not exist yet, and oxlint's type-aware coverage would need checking.
- The brief notes that yield order is not execution order. This contradicts the strongest intuition the syntax creates, and approval ordering then needs an explicit dependency even though the gate is written on the line above publish.
- `Effect.gen` contributes nothing to construction. No services are needed at build time. A generator that requires `Effect` just to build data is ceremony, and it brings back a phase where `yield* SomeService` could do I/O during graph construction.
- Typing `Output<T>` property projection (`release.version` as `Output<string>`) requires deep mapped or proxy types. Its autocomplete quality and error messages are **unproven**. Method projections such as `notes.length` make it worse.

**Verdict:** do not adopt this for workflows. Keep the Alchemy-style approach in mind for a future managed-resource API, if Effectory ever manages resources with reconcile and delete semantics.

## Option 3: explicit graph builder

**Strengths**

- **It is honest.** A plain callback, a visible `graph` variable and handles that plainly are not values. Nothing suggests real values or real execution.
- It is discoverable. Typing `graph.` lists every orchestration operation (task, approval, branch, forEach, scope, sleep, signal). The vocabulary sits in one place instead of several global modules.
- Errors are likely to point at the offending argument, such as a wrong input ref passed to `graph.task`. This is a reasonable expectation for a generic function call, but **unproven** for the "record of refs" input shape below.
- It supports structural extension patches, validation before activation, rendering a plan, and source locations captured per node at construction (a stack capture at each `graph.*` call), which helps debugging.
- Ordering by data and ordering by control coincide naturally when gates are expressed as branches (see the proposed example). That removes most of the "forgot an ordering dependency" failure mode the brief lists.

**Objections**

- As sketched, it is a second language for everything between tasks. String templates, field picks and small computations need an expression vocabulary, or else a task each. If every `` `Publish ${version}?` `` needs a vocabulary term, users will hate it.
- `release.output` plus property access suggests a proxy design that has not been specified. `{ repository: graph.input.repository }` as a task input needs a "value or ref, deeply" mapped type. That inference and its error messages are **unproven** and are the main prototype risk.
- `if (ref)` has the same silent bug as Option 2. The plain callback and the `graph.` prefix make it less likely, but they do not prevent it.
- Being explicit costs extra lines compared with Option 1 on the happy path.

**These can be fixed** (see Recommendation): pure function nodes remove most of the expression vocabulary, and the bundle-pinning design already makes this safe.

## Option 4: named step specification object

**Strengths**

- It is the best shape for data: generated or agent-edited workflows, diffing, JSON transport, and Swamp parity. Object keys as IDs removes duplicate names.

**Objections**

- `Ref.output("fetch")` is a string reference. Typos, renames and "find all references" all depend on extra type machinery. Inference across sibling keys in one object literal, including forward references, is exactly the case where TypeScript tends to give up or report the error on the outer call. The brief itself flags this. I agree, and I would not expect a pleasant result without a prototype that proves it.
- Branches and fan-out inside nested objects become deeply nested literals with poor error locality.
- Local variables are what TypeScript users reach for. This option takes them away.

**Verdict:** this is the right **normalized intermediate representation** (the thing patches, plans, the lake and agents operate on). It is the wrong primary authoring syntax for TypeScript users.

## Option 5: typed pipeline combinators

**Strengths**

- It is very pleasant for linear chains, and an approval gate that passes its input through on approval is elegant.
- Variadic pipe typing has precedent (Effect's `pipe` overloads) and tends to report errors at the bad argument rather than as a huge tuple error. That expectation is reasonable but **unproven** for schema-aware stages.

**Objections**

- Linear chains are not the common case once a workflow joins results, uses an earlier output later, or branches. Carrying context forward becomes a pass-through-record tax.
- "Rejects incompatible adjacent schemas" is a misleading claim if it means TypeScript assignability. A `Release` that has extra fields is assignable to a narrower input type, but whether schemas are compatible depends on how encode/decode handle excess properties, brands and transformations. The runtime must still encode with the producer's schema and decode with the consumer's. **Type compatibility is not schema compatibility.**
- The workflow input implicitly feeding the first stage forces exact shape matches, or adds map stages just to adapt.

**Verdict:** offer it as sugar inside the primary API (`graph.pipe(...)`). It should not be the workflow language.

---

## Shared Task and Application APIs: what hurts DX

The brief holds these constant. Several deserve changes in every option:

1. **Task boilerplate.** Requiring `version`, `error` and `replay` on every task is heavy for a first task. Suggestions:
   - Default `version` to `1`.
   - Default `error` to `Schema.Never`.
   - Keep `replay` required, since it is the one option that forces the author to think about side effects. Consider wording that describes the author's obligation instead of claiming a property, for example `replay: "safe"` or `"manual"`, with docs stating that `"safe"` requires honoring `idempotencyKey`. The current `"idempotent"` reads as a guarantee that the declaration cannot make.
2. **Two names per call site.** The task ID (`releases/fetch`) plus an invocation key (`fetch`) is necessary in principle. In a graph, the invocation ID could default to the task ID when a task is used once, and become required only on collision. Adding a second use then produces a build-time error rather than silently renaming the first. This is a reasoned suggestion, and stability under refactoring should be checked.
3. **Domain errors.** Encourage `Schema.TaggedError` classes rather than hand-written `_tag` literal structs. A graph workflow can also compute the union of escaping errors and report the specific task whose error the declared workflow error does not cover.
4. **Approval denial and timeout change the workflow's contract.** If an extension inserts a gate, the denied path needs an outcome. The original workflow's error schema does not include "denied". Make `Rejected` and `TimedOut` **standardized run outcomes**, alongside interruption and `ExecutionError`, so that inserted gates do not have to widen domain error types. Authors who want denial as a domain result can still branch on it explicitly. This affects every option and is not addressed in the brief.
5. **Testing and replacement (Question 5) has no customer API yet.** Add a first-class harness, for example `Workflow.test(ReleaseSummary).replace(FetchReleaseFake).run(input)`, that returns the run record. Use `.replace` for an explicit implementation swap, distinct from `.provide` for services. Per-deployment replacement belongs in host selection config, as the extension docs already propose.
6. **`Workflow.make(...)` followed by `.implement/.build`.** Separating the contract is right for child workflows and for extensions that target a contract. Also allow the one-step form for simple workflows, so a beginner writes one declaration instead of two.
7. **Explicit `Application.make({ tasks })` registration** is good: a reviewable surface with no auto-discovery. With a graph workflow, a missing task can be a startup error that says exactly which definition to add. That error should be designed as carefully as the API.

## Ranking (qualitative)

1. **Option 3 (graph builder): recommended primary, with the changes below.** It is honest about phases, discoverable, and it satisfies the inspection and patching requirements. Its main weakness, the expression vocabulary, can be fixed.
2. **Option 1 (executable program): a close second, and first if** structural extension patches and pre-run plans are dropped from the requirements. It is the most ergonomic today, but it carries a permanent replay footgun that experienced Effect users trigger most.
3. **Option 5 (pipeline):** adopt it as `graph.pipe` sugar only.
4. **Option 4 (spec object):** adopt it as the normalized IR, not as authored syntax.
5. **Option 2 (declarative generator): reject it for workflows.** It is the most misleading syntax for runtime-dependent branching, and its construction-time generator adds nothing.

Do not ship Options 1 and 3 as two overloaded workflow syntaxes. If both are kept, make the opaque program an explicit, separately named workflow kind that the plan view clearly shows as "opaque". Defer it until after the graph v0.

## Changes required before adopting Option 3

1. **Pure function nodes instead of a large expression AST.** Add `graph.map(id, ref, (value) => result)`, where the function is a plain, non-Effect function executed at run time. Because application revisions already pin the code bundle (see [edge-runtime.md](edge-runtime.md)), closures do not need JSON serialization: the node references the bundle. Record the result, so impure code cannot change a replay. The plan shows the node's ID, types and source location; only its body is opaque. Generated or agent-written workflows (the Option 4 IR) are limited to tasks and a small built-in vocabulary. That limit is acceptable.
2. **Branch by function, with cases visible.** Add `graph.branch(id, ref, (value) => caseName, { caseName: (b) => … })` and `graph.match(id, ref, { Tag: … })` for tagged unions such as approval outcomes. Every case's result must unify with the declared workflow success type, and the error should point at the failing case. **Prototype this.**
3. **Make approval a tagged result and gate by branching.** Approval returns `Approved | Denied | TimedOut`. Putting publish inside the `Approved` case makes ordering structural, with no separate `dependsOn`. Keep `graph.after(node)` for the rare order-without-data case.
4. **Fan-out:** `graph.forEach(id, ref, { key, concurrency }, (b, item) => …)`, with `key` as a required function. IDs become `id[key]/child`. Duplicate keys fail the step at expansion time, with the offending key named.
5. **Fragments for reuse.** `Graph.fragment(name, (g, input) => …)` is used via `graph.use(id, fragment, ref)`, and all IDs inside are prefixed. This answers Question 4.
6. **Ref ergonomics.** A node handle _is_ a `Ref<T>`. Field access via `ref.get("field")`, typed by `keyof`, avoids proxy name collisions. Allow task inputs as records of refs and values. **The deep "ref-or-value" mapped type is the highest inference risk.** Prototype it first, and measure error locality on a misspelled field and a wrong field type.
7. **Lint rules** for refs in conditions or template literals, and for `Effect`-returning functions passed to `graph.map`.
8. **Patches.** Add `Workflow.patch(target@version, (p) => p.before("publish", …))`, validated against the target graph and its schemas before activation, using the standardized `Rejected` and `TimedOut` outcomes from the shared-API section.
9. **Plan and run views.** `effectory workflow plan <id>` renders the template graph, showing fan-out as a template and map bodies as opaque with source locations. The run view overlays the actual execution on the same node IDs (Question 9).
10. **Diagnostics for dynamically loaded extensions (Question 8).** Since there is no typecheck, startup validation reports the node path, the source location captured at construction, the expected and actual schema, and any missing handler identity.

## Proposed example

> **PROPOSED, not typechecked; no implementation exists.** Names such as `graph.match`, `graph.map`, `graph.forEach`, `Graph.fragment`, `Workflow.patch` and `Workflow.test` are this review's suggestions. `PublishDraft` and `ReleaseFailure` are hypothetical additions. Assume `prerelease` has been added to `Release`.

```ts
// A reusable fragment: IDs become "<use-id>/fetch" and "<use-id>/render".
const FetchAndRender = Graph.fragment(
  "fetch-and-render",
  (g, input: Ref<Input>) => {
    const release = g.task("fetch", FetchRelease, input);
    const summary = g.task("render", RenderSummary, release);
    return { release, summary };
  }
);

export const ReleaseSummary = ReleaseWorkflow.build((graph) => {
  const { release, summary } = graph.use("main", FetchAndRender, graph.input);

  const review = graph.approval("review", {
    prompt: graph.map("prompt", release, (r) => `Publish ${r.version}?`), // recorded pure fn
    timeout: "24 hours",
  });

  // Publishing happens only inside the Approved case, so ordering is structural.
  return graph.match("decision", review, {
    Approved: (b) =>
      b.branch("channel", release, (r) => (r.prerelease ? "draft" : "public"), {
        draft: (c) => c.task("publish-draft", PublishDraft, summary),
        public: (c) => c.task("publish", PublishSummary, summary),
      }),
    Denied: (b) =>
      b.fail(new ReleaseFailure({ message: "Publication denied" })),
    TimedOut: (b) =>
      b.fail(new ReleaseFailure({ message: "Approval timed out" })),
  });
});

// Fan-out with stable keys (Question 1); this snippet goes inside a build callback.
const fetched = graph.forEach(
  "fetch-all",
  graph.input.get("repositories"),
  { key: (repo) => repo, concurrency: 4 },
  (b, repo) => b.task("fetch", FetchRelease, { repository: repo })
);

// An extension adds a gate without editing the source (Question 6).
// Denial yields the standard Rejected outcome, so the contract is unchanged.
export const RequireSecurityReview = Workflow.patch(ReleaseSummary, (p) =>
  p.before("main/render", (g) =>
    g.gate("security-review", { timeout: "48 hours" })
  )
);

// Test replacement (Question 5); this snippet goes inside an Effect.gen test body.
const run =
  yield *
  Workflow.test(ReleaseSummary)
    .replace(FetchRelease.implement(() => Effect.succeed(fixtureRelease)))
    .run({ repository: "owner/repo" });
```

What this example aims for, as reasoned opinion rather than a tested claim:

- Local variables are kept.
- Branching and fan-out read close to ordinary code.
- No step can run without being visible in the plan.
- The only opaque parts are pure, recorded functions.
- Extensions target stable, namespaced node IDs.

## Summary

- **Primary recommendation:** Option 3, the explicit graph builder, extended with recorded pure-function `map` and `branch` nodes, tagged approval outcomes, fragments, and Option 5 as `graph.pipe` sugar. Use Option 4 as the normalized IR that patches, plans, the lake and agents operate on.
- **Shortlist alternative:** Option 1, if the team decides that structural extension patches and pre-run plans are not core. In that case, constrain the workflow's `R` type, provide durable timeout and race operations, and document call-site interception as the extension mechanism.
- **Reject:** Option 2 for workflows. It reuses executable-looking syntax for lazy references in exactly the place where workflows most need real values.
- **Shared API changes:** default `version` and `error`; reword `replay`; standardized `Rejected` and `TimedOut` outcomes; a `Workflow.test(...).replace` harness; optional invocation IDs that default to the task ID.
- **Unproven:** all new inference (refs, deep ref-or-value inputs, branch-case unification, forward-ref specs, schema-aware pipelines). A type-level prototype of the `graph.task` input type and `graph.match` must come before any adoption decision.

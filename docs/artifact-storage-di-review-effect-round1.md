# ArtifactStorage through Effect DI — Effect review, round 1

Reviewed: [artifact-storage-di-proposal.md](artifact-storage-di-proposal.md) (not implemented, not user-approved), against `packages/core/src/{task,artifact,application,tag}.ts`, [the Tag DI contract](run-tags-di-contract.md) and the ownership sections of [the binary proposal](binary-artifacts-api-draft.md). Scope: the DI delta only. I do not review byte limits, storage/retention or transport choices. I do not argue against the user's direction, which is to yield `ArtifactStorage` and call `publish()`. I changed only this file. I made no production edits, no commits, no publication and used no subagents. Approval from this reviewer is not user approval.

Evidence labels:

- **Source fact**: read in this checkout or in `node_modules/effect` 4.0.5.
- **Tested**: a scratch probe outside the checkout, using this checkout's Effect 4.0.5, `tsc` 7.0.2 (effect-tsgo) and Bun 1.4.3. The probes are in `/private/tmp/claude-502/-Users-davidr--t3-worktrees-effectory-t3-21743e89/3d8f5efd-aed7-4950-87e2-3d6fc5c5e3e9/scratchpad/asdi/` (`probe.ts`, `probe2.ts`, `probe3.ts`, `run.ts`, `tap.ts`). They model the proposed types and barrier. They are not the SDK.
- **Proposal**: a reviewer suggestion. It has not been probed unless it says so.

## Verdict: REQUEST CHANGES (small)

The direction is sound Effect. A required `Context.Service` with a stable key, provided per invocation around the full execute (the Tag.Values placement), excluded from exposed R, and overridable with ordinary `Layer.succeed` is the idiomatic shape. Static inference works as claimed. The runtime membership check is honest about what a global service cannot know.

Three blockers stop the proposal from being presentable as written. Each has a small fix:

1. **B1 — Phase rule.** The handler-only rule is coherent but not the simplest sound placement. An equally small placement allows publishing during acquisition and forbids only publishing in finalizers. I probed it, and it is sound on failed acquisition too. Present that placement, or show the user both.
2. **B2 — Overloads.** Two overloads give a misleading diagnostic for the most common mistake. A single conditional signature fixes this and keeps E/R inference.
3. **B3 — Fakes.** The "ordinary `Layer.succeed` fakes without casts" claim is true only in a way that hides unsoundness. A fake with the wrong reference type typechecks. A fake that drains the stream needs one cast. Say this honestly.

Four smaller corrections (N1–N4) follow the blockers.

## What holds

- **Inference** (Tested, `probe.ts` t1–t4 and n1–n3, repeated in `probe3.ts`):
  - `publish(JsonArtifact, value, opts)` infers `A["refSchema"]["Type"]` with the literal `schemaId`.
  - A finite `Uint8Array` infers `E = never, R = never`.
  - A service-backed `Stream` keeps its `ReadErr` and `Fs` in E and R.
  - `Stream.make(...).pipe(Stream.encodeText)` adds nothing.
  - A wrong JSON value, bytes passed to a JSON artifact and a JSON value passed to a bytes artifact are all rejected.
  - A generic reusable helper `<A extends Json>(a: A, v: A["schema"]["Type"]) => storage.publish(a, v, …)` compiles (`probe2.ts`).

  An early version of my negative cases passed only because of an unrelated error. I fixed them and reran them, and they now fail for the intended reason.

- **Requirement exclusion** (Source fact plus Tested):
  - Changing `Tag.Values` to `Tag.Values | ArtifactStorage` in `definition`, `make`, `implementation` and both `provide` signatures (`task.ts:103`, `:221`, `:245`, `:260`, `:303`, `:325`) is mechanical. It commutes with excluding `ROut` in the same way the existing comment at `task.ts:242` argues for Tag.Values.
  - Other requirements survive (`probe.ts` `ex`).
  - `Application.make` derives `Requirements<T>` from `execute` (`application.ts:13`), so no runner-owned requirement leaks into the application Layer.
- **Duplicate SDK copies** (Tested, `probe2.ts` `dup`): a structurally identical service class from another copy, with the same key string, is removed by `Exclude`. The runtime lookup uses the key, so this works. A _version-skewed_ copy with a different `Publish` shape would stay in R and surface as an Application type error. That outcome is correct, and the proposal should mention it.
- **Precedence** (Source fact): `definition.execute` already installs runner services outermost, and `.provide` wraps the raw `execute` inside it (`task.ts:222–246`). So an inner `Task.provide(Layer.succeed(ArtifactStorage, fake))` overrides the default, and a caller-supplied instance outside `execute` is overridden. This is ordinary Effect, as the proposal says.
- **Per-invocation capture** (Source fact): each `execute` installs a fresh `Layer.CurrentMemoMap` (`task.ts:230–233`). A task-local helper Layer that captures storage cannot be reused by another run or retry. An Application Layer cannot see the service unless the user satisfies the requirement at application level (see N2).
- **Output membership**: object-identity resolution with an optional `output` alias is the right runtime check. The proposal correctly does not claim compile-time membership. A global service type cannot carry `OutputsOf<S>`, and the Effect type system will not narrow a service by the task currently providing it. I agree with the proposal's honesty on this point and add nothing to it.

## B1 — Phase rule: coherent, but present the simpler sound placement

**Source facts.** Today the supervisor/admission cell lives in the raw handler, inside every `.provide` wrapper (binary proposal line 88). That placement was natural because `context` did not exist during Layer acquisition. With DI, the service _is_ in scope during task-local acquisition, because it is installed in the same place as Tag.Values. The proposal resolves this by rejecting publication outside the handler window.

**Is the handler-only rule coherent?** Yes. It is sound: nothing is admitted unless the handler barrier can later interrupt it, and failed acquisition admits nothing. It also has two costs:

- **Consumer surprise.** `yield* ArtifactStorage` succeeds in an acquisition effect, but `publish` fails with InvalidBoundary depending on _when_ it runs. Neither the type nor the yield signals this. It is the one place where "available service" and "usable service" diverge.
- **A split owner.** The service is installed outermost, but its admission cell is opened by the raw handler innermost. The implementation needs a private channel from the outer installation to the inner handler, and it has to explain why a captured instance is "available but not yet open".

**Alternative placement (Tested, `run.ts` and `tap.ts`).** The admission and supervisor cell has exactly the lifetime of the installed service:

- Admission **opens** where the default service is installed, at `definition.execute` entry.
- The barrier **closes** at the _earliest task-local release point_. The barrier is idempotent: it rejects new admissions, interrupts outstanding children and awaits them. To find that point, the existing private `taskLayer` wrapper (`task.ts:163`) adds one `Layer.tap(() => Effect.addFinalizer(() => close))` to each task-local Layer. An outermost `Effect.ensuring(close)` covers tasks that have no task-local Layers.
- The tapped finalizer is registered right after its Layer acquires, so LIFO release runs it before that Layer's own release, and before any outer task-local Layer's release.

Probe outcomes:

- **Success.** The order is `A:acquire, acq-sync publish (source live), handler, close-barrier, acq-detached:interrupted, rejected:finalizer, A:release`.
- **Failed acquisition.** Layer A acquires and launches a detached publication. Inner Layer B then fails. The order is `A:acquire, acq-sync publish, B:fail, close-barrier, acq-detached:interrupted, rejected:finalizer, A:release`. The child is interrupted while A's source is still live. This is the case the proposal says the handler-only rule avoids. The alternative avoids it by registering the barrier with the Layer scope, not with the handler.
- **Memo sharing.** `Layer.tap` keeps memo sharing, so a shared Layer provided twice builds once.

The resulting rule is **"publish during task-local acquisition and in the handler; not in finalizers."** It is no larger than the handler-only rule, because both need one barrier and one admission cell. It removes the split owner and limits the remaining restriction to finalizers, which are already the place where Effect authors expect resource-relative work to be constrained.

**Can finalizer publication also be allowed?** Not equally simply. Here is the reasoning, which I did not probe:

- An _awaited_ publish inside a finalizer is ordered correctly by Effect, because its own Layer has not released yet.
- A _detached_ publish forked from a finalizer escapes, unless every finalizer re-sweeps the children. That requires separating "interrupt children" from "close admission" and repeating the sweep.
- A finalizer also runs after the task outcome is fixed, so its reference cannot be part of the success value.

Recommend rejecting finalizer publication in both placements, with the exact InvalidBoundary message.

**Smallest fix.** Replace the "handler execution phase" wording with the alternative placement, or present both to the user with this probe. In either case, state the following:

- Acquisition-time commits are durable even if a later Layer or the handler fails, the same as partial handler publication. A retry deduplicates by run/invocation/output/key.
- Forked fibers created in a Layer scope (`forkScoped`) are admitted until the barrier closes and are rejected after it.
- The guarantee covers only `Task.provide` Layers. An `Effect.provide`/`Effect.scoped` that the author writes _inside_ the handler releases before either barrier. A detached publish whose captured service comes from such an inner scope is not protected. This limitation already exists in the binary proposal. DI does not change it, but the new wording must not overclaim.

Supervisor interruption semantics do not change: an interrupted caller interrupts and awaits its registered child. The `run.ts` model uses the binary proposal's `uninterruptibleMask`/`onInterrupt` registration. Close ordering relative to the host commit fence also does not change.

## B2 — Use one conditional signature, not two overloads

**Tested (`probe2.ts`).** With the proposal's JSON-then-bytes overloads, `publish(Point, { x: "no" }, …)` reports `No overload matches… The last overload gave: missing properties kind, contentType`. That message points authors at the bytes overload when they made a JSON value mistake. Reversing the order only moves the problem to bytes mistakes.

**Tested (`probe3.ts`).** A single generic signature fixes this:

```ts
type Input<A, E, R> = A extends Bytes
  ? Uint8Array | Stream.Stream<Uint8Array, E, R>
  : A extends Json
    ? A["schema"]["Type"]
    : never;

<A extends Json | Bytes, E = never, R = never>(
  artifact: A,
  value: Input<NoInfer<A>, E, R>,
  options: Options
): Effect.Effect<A["refSchema"]["Type"], E | TaskRuntimeError, R>;
```

With this signature:

- A wrong JSON value reports `Type 'string' is not assignable to type 'number'` at the field.
- Stream E and R are still inferred (`t3neg` fails as intended).
- `A` is inferred only from the artifact.

JSON calls get `E = R = never` by default. This is one public signature, not a new DSL. If the overloads stay, the proposal should at least record the diagnostic cost.

## B3 — Be honest about what fakes check

**Tested (`probe.ts` 2a–2f, `probe3.ts` `fake`).**

- `Layer.succeed(ArtifactStorage, { publish: (a: Json | Bytes, v: unknown, o) => Effect.succeed({ artifactId: "fake", schemaId: a.id }) })` typechecks with no cast, as the proposal claims.
- **A fake returning `schemaId: "WRONG"` also typechecks.** Assigning a non-generic function to a generic method erases `A["refSchema"]["Type"]` to `any`. So the reference type is not checked in fakes.
- A fake with the wrong _error_ type is rejected, because E is still checked.
- A fake that actually drains a bytes `Stream` must cast the stream, for example to `Stream<Uint8Array>`. Draining it as `Stream<…, unknown, unknown>` leaks `unknown` into R and fails assignment.
- An overloaded function declaration also passes. The implementation body of an overload set is checked loosely.

**Smallest fix.** Rewrite the feasibility bullet to say:

- Simple fakes need no cast.
- Fakes are _not_ statically checked against the reference type. Decoding through `artifact.refSchema` is the recommended pattern, and it typechecks without a cast (2b).
- A stream-draining fake needs one internal cast.

No harness DSL is needed. This is the honest ergonomics cost the proposal asks reviewers to record.

## Non-blocking corrections

**N1 — The compatibility adapter's hidden requirement.**

- `TaskContext.publish` returns `Effect<…, TaskRuntimeError>` with no R. If it yields `ArtifactStorage` internally, it hides a requirement. That is a defect if author code wraps it in `Effect.provideContext(customContext)`.
- **Proposal:** implement it with `Effect.serviceOption(ArtifactStorage)`, falling back to the invocation's captured default instance. Overrides still win, and nothing dies on a missing service.
- Always forward `output: name` so that aliased outputs never become ambiguous through the adapter.

**N2 — Application-level satisfaction.**

- An Application Layer that requires `ArtifactStorage` correctly leaves the requirement on the Application. The types cannot stop a user from satisfying it with an application-level `Layer.succeed(ArtifactStorage, fake)`. That fake would be captured for every run and bypass persistence and the supervisor.
- The proposal states the rule ("must leave the service requirement on its operations"). It should name this specific failure mode in the authoring docs, as the Tag DI work did for Tag.Values.

**N3 — Foreign-instance diagnostics.**

- Identity-based membership will reject an artifact from a duplicated module copy with UnknownOutput.
- When a declared output has the same `id` but a different instance, make the message say so, for example "same id, different definition instance; check duplicate module copies". This turns the most likely cross-bundle mistake into a self-explaining error. It adds no registry lookup and no tolerance for schema drift.

**N4 — Where the default service comes from.**

- State that the default service is built in `definition.execute` from the low-level `RuntimeContext` (its `publish` plus admitted `tags`), together with the admission cell. That is the same object `Task.test` and the host already pass.
- `Task.test` then records publications through both authoring surfaces with no new code path. A `Task.provide` fake records nothing in `Task.test`, as the proposal already says.

## Required changes before presentation

1. Replace the handler-only phase rule with the alternative placement: acquisition and handler allowed, finalizers rejected, barrier registered via `taskLayer`. Alternatively, present both placements with the probe evidence. Add the inner-handler-scope limitation and the durability note for acquisition-time commits.
2. Change `publish` to the single conditional signature, or record the overload diagnostic cost.
3. Correct the fake feasibility claim: the reference type is unchecked, decoding through `refSchema` is the recommended pattern, and a draining fake needs one cast.

N1–N4 can be folded in alongside these. After these edits I would expect to approve the proposal for presentation. That approval would still not be user approval of the API or of the binary product decisions.

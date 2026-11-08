# Run tags metadata reading API — consumer review, round 1

Reviewer: Claude, as the consumer-DX review subagent. Subject: [run-tags-metadata-api.md](run-tags-metadata-api.md), read against [run-tags-contract.md](run-tags-contract.md) and the earlier [typed consumer review](run-tags-typed-review-consumer-round1.md). This is a review only. I made no production or unrelated doc edits, no commits and spawned no subagents. Reviewer approval is not user approval.

Settled and not reopened: typed callable `Tag.make` bindings, optional bare workflow declarations, early validation of present values only, and the persistence, query and schedule rules.

## Verdict

**Approve for presentation, with the small text corrections below (M1–M4).** None of them changes the API. They change examples and one documented idiom, so they can be applied without another review round.

From a consumer's point of view, the revision fixes what was wrong:

- **It reads as metadata.** `context.readTag(Team)` next to `context.tags` sits at the same level as artifacts and inputs. Nothing in the read path mentions Config, providers or the environment. My earlier C1 footgun is gone structurally: the definition is not yieldable and has no `.config`, so a handler cannot accidentally read `process.env` through a tag.
- **Absence is explicit and cheap.** `Option` is the right type for optional declarations. One `Option.getOrElse` handles the common case. Present but invalid values still fail rather than silently becoming `None`, which matches what a consumer expects from the "stronger type" they wrote.
- **Composition needs no new vocabulary.** `Effect.all({...})` over reads, followed by Option operations, is ordinary Effect code. I agree with not adding `Tag.all`, `Tag.option` or `withDefault`.
- **Authoring ergonomics are unchanged.** Mixed `[Team("platform"), DeploymentId, BuildNumber(42)]` arrays, schedule overrides and `Task.test` fixtures look exactly as the user approved.

## Evidence

I checked the pinned Effect 4.0.5 source and ran a scratch probe with bun; the probe file was removed afterwards and is not committed.

- `Schema.decodeUnknownEffect` exists (Schema.ts:499ff). With the canonical codec `String.pipe(decodeTo(toCodecStringTree(s)))`:
  - Int `"42"` gives 42, and Int `"042"` also gives 42.
  - Int `"abc"` fails with `SchemaError(Expected a string representing a finite number)`. **The message does not name the key.**
  - NonEmptyString `""` fails, and String `""` succeeds with `""`.
- `Effect.all({ a: Effect<Option<number>>, b: Effect<Option<string>> })` gives a struct of Options, and `Option.all(struct)` collapses it to `Option<{...}>` (Option.ts:3012).
- `Effect.fromOption(option, onNone)` exists, and its error type is inferred from `onNone` (Effect.ts:2695). This is what M1 relies on.
- `TaskContext.tags` is currently `Readonly<Record<string,string>>` (task.ts:31). The handler error channel is `spec error | TaskRuntimeError` (task.ts:181). A read typed as `Effect<Option<A>, TaskRuntimeError>` therefore needs no mapping in handlers.

I did not prove the generic `readTag<Key, S>` inference against a real `Tag.Definition` type, because none exists. The doc already lists that as a focused proof.

## Minimal corrections

### M1 — Document the idiom for a task that cannot proceed without a tag (should fix; documentation only)

The most common practical question after "how do I default it?" is "this task needs `deployment`; how do I fail cleanly when it is absent?". The doc only shows `getOrElse`. Without guidance, consumers will write `Option.getOrThrow`, which becomes a defect and loses the message, or reach for `Effect.fromOption` without `onNone`. The second option yields `NoSuchElementError`, which the handler's error channel rejects at compile time. Show the one-line standard idiom, and add no API for it:

```ts
const deployment =
  yield *
  context.readTag(DeploymentId).pipe(
    Effect.flatMap((value) =>
      Effect.fromOption(
        value,
        () =>
          new TaskRuntimeError({
            code: "MissingTag",
            message: "run tag 'deployment' is required by this task",
          })
      )
    )
  );
```

State that this is a local decision made by the read, and that it does not make the declaration required at admission. That keeps the user's optional choice intact while answering the obvious question. Pick the `code` string at implementation time; `InvalidBoundary` is acceptable if no new code is wanted.

### M2 — Present one complete, uncommented handler example (should fix)

Every usage in "Proposed consumer shape" is commented out, and the workflow spec appears only as a comment. For the user-facing presentation, show one real `Task.make` handler body that uses `readTag` + `getOrElse`, one `Effect.all` read, and the M1 idiom. Add one CLI line, such as `effectory run deploy --tag deployment=deploy-42`, so the metadata path from operator to handler is visible end to end. Today a reader has to piece that flow together from points 1–10.

### M3 — Fix the example semantics (should fix)

- **`BuildNumber(42)` as a workflow default reads wrong.** A build number is per-run metadata, and a fixed default of 42 on the workflow suggests every run is build 42. Make `BuildNumber` a bare declaration supplied by a schedule, CLI or fixture. For the defaulted typed example, use a literal classification such as `Tag.make("classification", Schema.Literals(["internal", "public"]))` with `Classification("internal")`. This also demonstrates a non-string decoded type through a literal union.
- **Make variable names match keys:** use `Deployment` for key `"deployment"` and `Build` for `"build"`, or rename the keys. `DeploymentId` vs `"deployment"` makes readers wonder which name the CLI expects.
- **When folding this into [run-tags-contract.md](run-tags-contract.md)**, replace its leading `Environment = Tag.make("env", Literals(["dev","prod"]))` + `Config.all` example. Besides the Config framing, `env` with dev/prod is exactly the configuration-shaped example this revision is trying to move away from, and its key collides with the environment-variable intuition. The other old drafts can stay historical with their existing link banner. [run-tags-typed-api-draft.md](run-tags-typed-api-draft.md) still shows `DryRun`; the revision's banner covers it, so it only needs a link and no rewrite.

### M4 — State two read behaviors consumers will notice (nit, one sentence each)

- **Key in error messages.** Raw `SchemaError` text does not name the key (probe: "Expected a string representing a finite number"). Point 4 already requires the key in the mapped message. Add a focused proof that the `TaskRuntimeError.message` for an invalid present value contains the key, such as `build`, and the issue.
- **Decoded vs stored values.** `context.tags.build` can be `"042"` while `readTag(Build)` gives `Some(42)`. Say so in one sentence: `tags` is the stored label, and `readTag` is the decoded view. This prevents "why don't they match" confusion when propagating labels versus using values.

## Not requested

- Renaming `readTag`. The name is clear next to `tags`. `Option` in the return type, shown in hover text, signals absence well enough.
- An `Option.all` helper or a struct-level reader. `Effect.all` + `Option.all` already covers this; at most, mention `Option.all` once in the M2 example.
- Restricting branching on metadata. Point 11's guidance about which examples to use is the right lever. Enforcement would be overreach.

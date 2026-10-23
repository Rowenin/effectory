# Implementation plan: automation primitives

Implements [automation-primitives.md](./automation-primitives.md). The proposal and its Decisions are final; this file records layout, ownership, and the choices the proposal leaves open.

## Package layout

The repository root is the collection. Libraries live in `packages/`.

| Path | Package | Contents |
| --- | --- | --- |
| `packages/core` | `@effectory/core` | Authoring primitives and the runtime: `Output`, `Node`, `Workflow`, `Action`, `Resource`, `Provider`, `Each`, `Call`, `Assert`, `Approve`, `Data`, `Secret`, `Target`, `Trigger`, `Report`, `Collection`, `State`, `Plan`, `Engine`, `Test`. |
| `packages/std` | `@effectory/std` | Standard library: `Process` service (ported from `@effectory/activities`), `Shell` Action, `Agent` Actions (Claude/Codex, ported), `T3` Actions (ported from `@effectory/t3`), `Worktree` and `Service` Resources, `GitHub.PullRequestComment` Resource on `@distilled.cloud/github`. |
| `packages/cli` | `@effectory/cli` | The `effectory` command. Loads `effectory.ts` from the current directory. |
| `effectory.ts`, `workflows/` | (root) | The collection: `verify-pr`, `review-branch`, `implement`, targets, triggers. |

Removed: `packages/{runtime,sdk,activities,t3,docs}`, `src/`, `scripts/`, `.effectory/`, `automation/`, `effectory.run.ts`, the release workflow, install/dogfood/vendoring machinery, the fingerprint allowlist, and every use of `effect/workflow` and `effect/cluster`.

## Core modules (`packages/core/src`)

Files are kebab-case (the repo's lint rule); each is exported as a PascalCase namespace from `@effectory/core` (`output.ts` → `Output`).

| Module | Responsibility |
| --- | --- |
| `Output.ts` | `Output<A>`: lazy reference with `upstream` node ids and an `evaluate(lookup)` function. Property access on an Output is an Output (proxy). `map`, `all`, `of`, `isOutput`, `upstreamOf(value)`, `resolve(value, lookup)`, `isResolved(value)`. |
| `Node.ts` | `NodeSpec` (the engine's generic node contract), `Registry` service, namespaces, node options (`when`, `runIf`, `allowFailure`, `dependsOn`, `keep`) and their pipeable forms. |
| `Workflow.ts` | `Workflow.make(name, { description, input, scope, reports }, body)`. |
| `State.ts` | `State` service. SQLite via `@effect/sql-sqlite-bun`: runs, node statuses, immutable records, resource state rows, approvals. `State.layer(file)`, `State.memory`. |
| `Plan.ts` | Run the body with a collecting `Registry`, build `Graph.directed<PlanNode, Edge>`, reject cycles (`Graph.findCycle`), order (`Graph.topo`), render text and Mermaid, snapshot. |
| `Engine.ts` | `Engine` service. One fiber per node, a `Deferred` per node, a global `Semaphore`, intent/terminal status writes, resume, revision refusal, dynamic expansion, finish (run-lifetime cleanup, reports). |
| `Action.ts` | `Action.make`, `rerun: "always" \| "on-change"`, `retry: "never"` → `OutcomeUnknown`, optional `fake` implementation. |
| `Resource.ts`, `Provider.ts` | Resource declarations with props/attribute schemas, `Provider.effect`/`succeed`/`dual`, `Unowned`, `adopt`, `lifetime`, `checks`, replace/deleteFirst, `deleteResource`. |
| `Control.ts` | `Each` (static + dynamic), `Call`, `Assert` (+ `failOn`, JUnit), `Approve`. |
| `Data.ts`, `Secret.ts`, `Target.ts`, `Trigger.ts`, `Report.ts` | Support primitives. |
| `Collection.ts` | `Collection.make` with the typed requirement check and `describe` (JSON Schemas). |
| `Test.ts` | `Test.run(workflow, input, { mode })`, `Test.provider(provider, cases)`. |

## The engine contract

Every primitive is a `NodeSpec`; the engine knows nothing about Actions or Resources:

```ts
interface NodeSpec {
  fqn: string; // "verify-pr/check/test"
  kind: NodeKind; // "action" | "resource" | "assert" | "approve" | "each" | "call" | "data" | "secret"
  type: string; // "Shell", "GitHub.PullRequestComment", ...
  input: unknown; // may contain Outputs; deps are its upstreams + when + dependsOn
  options: NodeOptions;
  codec?: Schema.Codec<unknown, unknown>; // JSON codec for the value persisted in node status
  record?: boolean; // write the value as an immutable Record on success
  reuse: "record" | "never"; // on resume, reuse a succeeded status ("never": Resources, Secrets re-converge)
  plan?: (ctx) => Effect<PlannedChange>;
  execute: (ctx: ExecContext) => Effect<NodeResult, unknown>;
  cleanup?: (ctx) => Effect<void>; // run-lifetime teardown at finish
}
```

## Choices where the proposal is silent

1. **Resources always re-converge on resume.** A succeeded Resource node is not reused from its node status; resume calls `read` and, if needed, `reconcile`. A run-lifetime `Worktree` removed by a failed run's cleanup is therefore recreated when that run is resumed.
2. **Skips propagate.** By default (`runIf: "succeeded"`) a node is skipped when an upstream failed or was skipped. `allowFailure` affects only the run's status; downstream nodes still see the failure.
3. **Suspension blocks only dependents.** Nodes downstream of a suspended `Approve` stay `pending`; independent branches finish. The run is `suspended` until resumed.
4. **Resume** reuses succeeded Action/Assert/Data nodes, reruns everything else, and refuses a different revision. Failed runs can be resumed (retrying failed nodes); `run cancel` finishes the run, deleting run-lifetime resources.
5. **`retry: "never"`**: an Action found `running` on resume fails with `OutcomeUnknown` and opens an approval `retry:<fqn>`; approving it and resuming reruns the Action.
6. **Admission.** `scope` is the admission key: a new run of a workflow is refused while an unfinished (running or suspended) run with the same scope exists.
7. **Revision** is a SHA-256 over the collection root's transitive local imports (via `Bun.Transpiler`) plus `bun.lock`.
8. **Exit code.** Without `--fail-on`, any failed assertion fails the run (`--fail-on low`); `--fail-on none` disables.
9. **Resources declare schemas.** `Resource.make(type, { props, attributes })` takes Schemas rather than a type-only declaration, so `describe --json` can emit JSON Schemas and state rows can be decoded.
10. **State location.** `$EFFECTORY_HOME/state.sqlite` (default `~/.effectory`), keyed by collection name, so every checkout shares one history.
11. **Docs site removed.** The Astro docs package is dropped; docs are the README, `AGENTS.md`, and Markdown in `docs/`.
12. **Providers receive `fqn` and `scope`.** Lifecycle inputs carry both, so providers can derive external names (worktree paths, comment markers) that never collide between scopes. They do not carry the collection name (see open issues).
13. **`Lifetime.run` cleanup includes failed Resources.** A Resource whose reconcile failed after its intent row may have created its object, so finish deletes it too.
14. **Reports see one snapshot.** Every report renders from the run's records as they were before any report, so reports never see each other.
15. **Assert runs on `completed`.** An assertion whose input is unavailable (upstream failed or skipped) records `passed: false` instead of failing or skipping.
16. **Exit codes.** 0 succeeded; 1 failed, cancelled, or failing assertions at `--fail-on`; 2 suspended awaiting approval.
17. **`run` subcommands.** `run resume|inspect|list|cancel` are subcommands of `run`; a workflow cannot be named `resume`, `inspect`, `list`, or `cancel`.
18. **`--junit`.** Bare `--junit` writes `junit.xml`; `--junit=<file>` (or `--junit <file>.xml`) names the file.
19. **Shell runs for real in fake mode.** Fake mode swaps providers and Action fakes; local commands still run, and the fake `Worktree` is an empty temporary directory.
20. **Secrets** come from `SecretStore` layers (`env`, `fromRecord`, `make`). 1Password/Doppler/Infisical stores are not implemented in v1.

## Open issues

- Provider inputs lack the collection name, so two collections using the same scope and FQN would share worktree paths and GitHub comment markers.
- The fake GitHub comment store is per process: a second CLI invocation in fake mode recreates the comment instead of updating it.
- `Trigger.serve` runs dispatched runs in the server process; there is no queue or durable timer, and approvals wait indefinitely (as the proposal states).
- Record retention (`keep`) prunes on write only; there is no background garbage collection.

## Work split

1. Foundations (lead): `Output`, `Node`, `Workflow`, `State`, `Plan`, `Engine`, `Action`, `Collection` skeleton, engine tests.
2. Parallel (subagents, against the contract above):
   - Resource + Provider + Test harness.
   - Control: Each, Call, Assert/JUnit, Approve.
   - Data, Secret, Target, Trigger, Report.
   - std Actions: Process, Shell, Agent, T3 (ported with their tests).
3. Parallel: std Resources (Worktree, Service, GitHub comment); CLI.
4. Lead: collection workflows, `AGENTS.md`, README/docs, end-to-end verification.

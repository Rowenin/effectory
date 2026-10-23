# Proposal: automation primitives

Status: draft for discussion. Supersedes the in-repo workspace model; Effectory becomes an **automation collection**: one repository of typed automations that act on other repositories and services.

Goal: solve the problems Swamp solves (repeatable agent work, typed operations, versioned data, assertions, approvals, secrets, triggers) with a runtime modeled on Alchemy's: a program that declares a graph of typed nodes, a side-effect-free plan, and a write-ahead state machine that converges external state through provider lifecycles. External APIs come from `@distilled.cloud/*`.

Sources: [Swamp manual](https://swamp-club.com/manual), [Alchemy](https://github.com/alchemy-run/alchemy/tree/cb4ec94ef99058fe8d4b9d5e84c4a177ae1292bf) (`packages/alchemy/src/{Resource,Provider,Plan,Apply,Action,Output}.ts`, `State/`), [distilled](https://github.com/alchemy-run/distilled).

## Primitives at a glance

| Tier | Primitive | Swamp problem | Alchemy origin |
| --- | --- | --- | --- |
| Core | `Output<T>` | CEL `${{ }}` wiring between steps | `Output` / `Expr` |
| Core | `Action` | behavior method run; `command/shell` | `Action` |
| Core | `Resource` + `Provider` | behavior with create/update/delete; factory pattern; idempotency | `Resource`, `ProviderService` |
| Core | `Workflow` | workflow DAG, jobs, steps, inputs | `Stack` program + `Plan`/`Apply` |
| Control | `Each`, `when`, `runIf`, `Call` | `forEach`, `guard`, `dependsOn` conditions, nested workflows | plan graph |
| Control | `Assert` | `assert` steps, `--fail-on`, `--junit` | test harness assertions |
| Control | `Approve` | `manual_approval`, suspension | `deploy` approval |
| Data | `Record` / `Data` | versioned data, `data.latest`, `data query` | `State` store |
| Support | `Secret` | vaults, sensitive arguments | `Secrets/`, `Redacted` |
| Support | `Target` | behavior definitions | stages, `ref` |
| Support | `Trigger` | schedules, webhooks | — |
| Support | `Report` | reports, JUnit | `Report` |
| Support | `Test` | `swamp-testing` | `alchemy/Test`, provider modes |

Everything is an ordinary Effect value. Services (`Process`, `Agent`, distilled clients, `SecretStore`, `State`) are Effect Layers. There is no YAML or expression language.

## Core

### `Output<T>`: lazy references that build the graph

A workflow body runs once per run, at plan time, with the run's decoded input as plain values. Every node constructor returns an `Output<T>` (or, for Resources, an object whose attributes are Outputs). Passing an Output into another node's input creates a dependency edge. Outputs are not values: JavaScript `if` and loops cannot inspect them. Use `Output.map`, `Output.all`, `when`, and `Each`.

```ts
const sha = Output.map(checkout.head, (head) => head.slice(0, 7));
const all = Output.all([test, lint]);
```

Ported from Alchemy's `Output.ts`, including `upstream` extraction for edges and `isResolved` for plan-time diffing.

### `Action`: an imperative, recorded step

```ts
export const Shell = Action.make("Shell", {
  input: Schema.Struct({
    cwd: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
  }),
  output: ShellResult, // { exitCode, stdout, stderr, durationMs }
  rerun: "always", // or "on-change": skip when an earlier run in this scope succeeded with the same input digest
  run: (input) => Process.exec(input).pipe(nonzeroExitAsData),
});

// in a workflow
const test =
  yield *
  Shell("test", { cwd: checkout.path, command: "bun", args: ["run", "test"] });
```

- Output is schema-validated and written as a `Record`. A nonzero exit or unhealthy response is data, not failure, per Swamp's "the behavior records, the workflow decides".
- `rerun: "on-change"` is Alchemy's Action semantics and replaces Swamp's idempotency guards.
- Delivery is at-least-once. An Action interrupted mid-run reruns on resume. Declare `retry: "never"` for unsafe Actions; an interrupted one then fails with `OutcomeUnknown` and needs an approval to retry.
- Running an Action by itself does not need a workflow. `effectory action run Shell --input ...` wraps it in a one-node workflow, matching `swamp behavior run`.

### `Resource` and `Provider`: converge external state

For anything that creates or mutates external state: PR comments, issues, branches, preview environments, worktrees, and background processes.

```ts
export type PullRequestComment = Resource<
  "GitHub.PullRequestComment",
  { owner: string; repo: string; number: number; body: string },
  { commentId: number; url: string }
>;
export const PullRequestComment = Resource<PullRequestComment>(
  "GitHub.PullRequestComment"
);

export const PullRequestCommentProvider = Provider.effect(
  PullRequestComment,
  Effect.gen(function* () {
    const marker = (fqn: string) => `<!-- effectory:${fqn} -->`;
    return {
      stables: ["commentId"],
      read: ({ fqn, olds, output }) =>
        output
          ? Github.issues
              .getComment({ ...ownerRepo(olds), comment_id: output.commentId })
              .pipe(
                Effect.map(toAttributes),
                Effect.catchTag("NotFound", () => Effect.succeed(undefined))
              )
          : findCommentByMarker(olds, marker(fqn)), // returns Unowned(attrs) without our marker
      diff: ({ olds, news }) =>
        olds.number !== news.number
          ? { action: "replace" }
          : olds.body !== news.body
            ? { action: "update" }
            : undefined,
      reconcile: ({ fqn, news, output }) =>
        output
          ? Github.issues.updateComment({
              ...ownerRepo(news),
              comment_id: output.commentId,
              body: `${news.body}\n${marker(fqn)}`,
            })
          : Github.issues.createComment({
              ...ownerRepo(news),
              issue_number: news.number,
              body: `${news.body}\n${marker(fqn)}`,
            }),
      delete: ({ olds, output }) =>
        Github.issues
          .deleteComment({ ...ownerRepo(olds), comment_id: output.commentId })
          .pipe(ignoreNotFound),
    };
  })
);
```

The contract is Alchemy's `ProviderService`, trimmed:

| Method | Required | Meaning |
| --- | --- | --- |
| `read` | yes | Observe live state. Return attributes, `Unowned(attrs)`, or `undefined` if absent. Used for adoption and crash recovery. |
| `diff` | no | `noop`, `update`, or `replace` (`deleteFirst?`). Defaults to deep-equal props → `update`. |
| `reconcile` | yes | Create or update to `news`. Must be idempotent. |
| `delete` | yes | Idempotent. Fail with `DeleteInProgress` to be retried. |
| `stables` | no | Attributes known at plan time across updates. |
| `checks` | no | Preflight Effects run before `reconcile`/`delete` (Swamp pre-flight checks). |

**Identity.** A Resource's state key is `(collection, scope, FQN)`. The FQN is the namespace path plus the logical ID (`verify-pr/summary`). The scope comes from the workflow (below). Because the key is stable across runs, rerunning `verify-pr` for PR 12 updates the same comment instead of posting another. That is Swamp's factory pattern and idempotency guide, solved structurally.

**Lifetime.** `lifetime: "run" | "scope"` (default `"scope"`). Run-lifetime resources are deleted when the run finishes, like Alchemy's scratch stages. That covers the two cases Process can't today:

- `Worktree("checkout", { repo, ref })`: a temporary checkout, removed after the run.
- `Service("fixture", { command, args, ready: Http.ok(url) })`: a background process. `read` checks the PID and readiness, `reconcile` starts it, and `delete` stops it. After a crash, `read` sees the process is gone and `reconcile` restarts it.

**Orphans.** Not detected in v1; see Decisions.

### `Workflow`: a program that declares a graph

```ts
export default Workflow.make(
  "verify-pr",
  {
    description: "Check out a PR, run its checks, assert, and post a summary.",
    input: Schema.Struct({ repo: RepoRef, pr: Schema.Int }),
    scope: ({ repo, pr }) => `${repo.owner}/${repo.name}#${pr}`,
  },
  Effect.fn(function* ({ repo, pr }) {
    const checkout = yield* Worktree("checkout", {
      repo,
      ref: `pull/${pr}/head`,
    }).pipe(Lifetime.run);
    const checks = yield* Each("check", repo.commands, (cmd) =>
      Shell(cmd.name, {
        cwd: checkout.path,
        command: cmd.command,
        args: cmd.args,
      })
    );
    yield* Each("passes", repo.commands, (cmd, i) =>
      Assert(cmd.name, {
        that: Output.map(checks[i], (r) => r.exitCode === 0),
        message: Output.map(
          checks[i],
          (r) => `${cmd.name} exited ${r.exitCode}`
        ),
        severity: cmd.severity ?? "high",
      })
    );
    const body = Output.map(Output.all(checks), renderSummary);
    yield* PullRequestComment("summary", {
      owner: repo.owner,
      repo: repo.name,
      number: pr,
      body,
    });
    return { checks };
  })
);
```

- `scope` keys resource state and `rerun: "on-change"` caching, and replaces today's request key as the admission idempotency key. The same scope means the same external objects.
- A workflow's required services, its Providers and distilled clients, appear in its type. `Collection.make` (below) fails to typecheck until they are provided.
- `Call("notify", otherWorkflow, input)` runs a workflow as a node, with its records, approvals, and resources namespaced under `notify/`.

## Control

- **`Each(name, items, f)`** fans out concurrently, with `{ concurrency }`. If `items` is a literal, the plan shows every child node. If it's an `Output<array>`, the node expands into children at execution time and the plan shows one node.
- **`when: Output<boolean>`** on any node skips it when false (Swamp `guard`, inverted).
- **`runIf: "succeeded" | "completed" | "failed"`** on any node: by default, a node is skipped when any upstream failed. `completed` runs a node regardless, which is needed for cleanup and reports.
- **`allowFailure: true`** records a node's failure without failing the run.
- **`Assert(name, { that, message, severity })`** writes an `AssertResult` record `{ passed, message, severity }` and returns `Output<boolean>`. It never stops the graph. `effectory run ... --fail-on low|medium|high` sets the exit code; `--junit [file]` emits JUnit. Gate later nodes with `when: passed`.
- **`Approve(key, { title, review, when })`** suspends the run with a recorded review payload. `approval approve` records the decision, and `run resume` continues. Rejection fails the run. Unchanged from today.

## Data

Every Action, Resource, and Assert writes an immutable `Record` keyed by `(collection, scope, FQN, runId)` with a schema identity and timestamp. Resources also keep a mutable state row: Alchemy's `creating → created`, `updating → updated`, `replacing → replaced`, and `deleting` statuses.

```ts
const previous = yield * Data.latest(Shell, "verify-pr/check/test", { scope }); // Output<ShellResult | undefined>
```

```sh
effectory data latest verify-pr/check/test --scope acme/app#12
effectory data versions verify-pr/check/test --scope acme/app#12
effectory data query --kind Shell --where 'exitCode != 0' --since 7d
```

This covers Swamp's "the output of automation becomes input for later automation". Retention is a per-node `keep: { versions } | { days }` (Swamp `garbageCollection`).

## Support

**`Secret(name)`** returns `Output<Redacted<string>>` from a `SecretStore` layer: environment variables, or 1Password, Doppler, or Infisical through distilled. Values never enter records; a record stores `{ secret: name }`. Provider credential layers are built from Secrets in the collection root.

**`Target`** is a named, versioned input preset for a workflow (Swamp behavior definitions):

```ts
export const cypressApp = Target.make(verifyPr, "cypress-app", {
  repo: {
    owner: "cypress-io",
    name: "app",
    commands: [{ name: "test", command: "pnpm", args: ["test"] }],
  },
});
// effectory run verify-pr --target cypress-app --input pr=12
```

**`Trigger`** binds a workflow to `Trigger.schedule("0 3 * * *", target)` or `Trigger.webhook({ route, verify: Github.signature(Secret("gh-webhook")), map: (event) => input })`. Triggers are served by `effectory serve`.

**`Report.make({ name, render })`** renders a run's records into an artifact (Markdown or JUnit) after the run, with `runIf: "completed"`.

**`Test`**: providers may register `Provider.dual({ live, fake })`, which is Alchemy's provider modes. `Test.run(workflow, input, { mode: "fake" })` runs the whole graph against fakes and returns its records and asserts. `mode: "live"` runs in a scratch scope and deletes every resource afterward. `Test.provider(PullRequestCommentProvider, cases)` exercises create, update, replace, delete, and read-after-interrupted-reconcile.

## Collection root

```ts
// effectory.ts
export default Collection.make({
  workflows: [verifyPr, reviewBranch, implement],
  targets: [cypressApp],
  triggers: [nightly],
  providers: Layer.mergeAll(
    PullRequestCommentProvider,
    WorktreeProvider,
    ServiceProvider
  ),
  services: Layer.mergeAll(
    Process.layer,
    Agent.make(Claude.make({ model: "claude-sonnet-5-5" })),
    GithubLive,
    SecretStore.env
  ),
});
```

`effectory describe --json` lists every workflow, Action, Resource type, and Target with JSON Schemas. That is the agent discovery surface, replacing `swamp behavior type search` and `describe`. A collection ships an `AGENTS.md` skill: "extend an existing workflow or Action before writing a script."

## Execution

1. **Plan.** Decode the input, run the workflow body with Layers that only register nodes, and build the graph. For each Resource, load its state row, then call `read` (no row) or `diff` (row). For each Action with `rerun: "on-change"`, compare input digests. `effectory run verify-pr --plan` prints this without side effects.
2. **Execute.** Walk the graph in topological order with bounded concurrency. Each node goes `pending → running → succeeded | failed | skipped | suspended`. Write the intent row before acting and the terminal row plus record after. Resources call `checks`, then `reconcile` or `delete`.
3. **Resume.** Succeeded nodes return their records. A node left `running`: Resources call `read`, then `reconcile` (Alchemy's recovery path); Actions rerun, or fail with `OutcomeUnknown` if they declared `retry: "never"`. Suspended approvals wait for a decision.
4. **Finish.** Delete run-lifetime resources (`runIf: "completed"` semantics), render reports, then compute the exit code from failures and `--fail-on`.

State lives behind a `State` service (SQLite by default), keyed by collection, scope, and FQN. It does not depend on the workspace path, so every checkout and worktree of the collection shares one history.

## What changes from today

| Today | Proposed |
| --- | --- |
| `Task.make` | `Action.make` (imperative) or `Resource` + `Provider` (convergent) |
| `Workflow.make(...).pipe(step, each, compute, publish, approve, returns)` with `$` proxies | an `Effect.fn` body with `yield*` nodes and `Output` values; `compute` → `Output.map`; `publish` → every node is a record |
| `Automation.define` | removed |
| request key | `scope` |
| ClusterWorkflowEngine + SingleRunner | an `effect/Graph` plan executed one fiber per node over a `State` service |
| `.effectory/` embedded in host repos, vendoring, fingerprint allowlist | a standalone collection; revisions = automation source graph + lockfile; any locked npm dependency |

## Engine

The engine sits behind an `Engine` service so it can be swapped. The first implementation is a small graph engine, not Effect Workflow.

**Plan representation: `effect/Graph`.** The plan is a `Graph.directed<PlanNode, Edge>`. `effect/Graph` (in `effect` 4.0.5, marked `@stability unstable`) is a pure data structure; it gives us what the planner needs and nothing it doesn't:

- `Graph.directed` / `addNode` / `addEdge` build the plan from the registered nodes and their `Output` upstreams.
- `Graph.findCycle` rejects cyclic plans with the offending path, and `Graph.topo` orders `--plan` output.
- `Graph.toMermaid` renders `effectory run --plan --mermaid`.
- `Graph.toSnapshot` / `fromSnapshot` persist the plan with the run, so resume and inspection read the exact graph that ran.

It does not execute anything; execution is ours.

**Execution: one fiber per node.** This is Alchemy's scheduler (`Apply.ts`): give every node a `Deferred`, fork every node at once, have each node await its upstreams' Deferreds and then run, and complete its own Deferred with its output or failure. A failed upstream fails the await, so the downstream is marked `skipped`, unless its `runIf` allows it. A `Semaphore` bounds concurrency. Parallelism is maximal without computing layers, and `Each` over an `Output` just adds nodes and Deferreds when its input resolves.

**Durability: statuses in `State`.** Each node's status (`pending → running → succeeded | failed | skipped | suspended`) and record are written through the `State` service, SQLite by default. Resume loads the snapshot and statuses, completes the Deferreds of succeeded nodes from their records, and runs the rest. Approvals are `suspended` nodes; `approval approve` writes the decision and `run resume` continues. No durable timers in v1: approvals wait indefinitely, as they do today.

This drops `ClusterWorkflowEngine`, `SingleRunner`, and `effect/workflow` from the runtime.

## Decisions

1. **Engine.** Our own graph engine, described above.
2. **Code changes mid-run.** Each run records the collection revision. Resuming a run under a different revision is refused; restore the source or start a new run. This is today's behavior and the simplest rule.
3. **Dynamic fan-out.** Allowed. `Each` over an `Output` expands at execution time and appears as one node in the plan.
4. **Orphans.** No orphan detection in v1. A resource that later runs stop declaring keeps its state row and external object. Only `lifetime: "run"` resources are deleted automatically. `effectory resource delete <fqn> --scope ...` removes one by hand.
5. **Agent Actions.** No special default. Actions rerun after an interruption. For a write-capable agent working in a run-lifetime `Worktree`, a rerun starts from whatever the interrupted attempt left behind, which is the same as the fix loop in today's `implement` workflow. `retry: "never"` stays available for Actions whose duplicate would be harmful, like sending a message without a Resource to reconcile it.

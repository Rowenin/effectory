# Effectory

Effectory is a collection of typed automations that act on other repositories and services: verify a pull request, review a branch with agents, implement a change until its checks pass. Every automation is an ordinary [Effect](https://effect.website) program that declares a graph of typed nodes. A small engine plans the graph without side effects, then executes it with every step recorded, so runs can be inspected, resumed after a crash, gated on approvals, and queried later.

The design follows [Alchemy](https://github.com/alchemy-run/alchemy)'s runtime: `Output` references wire nodes together, `Resource`s converge external state through `Provider` lifecycles with write-ahead state, and `Action`s record imperative steps. External APIs come from [`@distilled.cloud/*`](https://github.com/alchemy-run/distilled). See [the proposal](docs/proposals/automation-primitives.md) and [the implementation notes](docs/proposals/automation-primitives-plan.md).

## Quick start

Requires Bun 1.4.3 or later.

```sh
bun install
bun effectory describe                        # what this collection offers
bun effectory run verify-pr --target effectory --input pr=12 --plan
bun effectory run smoke --input repo=$PWD     # worktree + background service + checks, for real
bun effectory run verify-pr --mode fake --input-json '{"pr":7,"repo":{"owner":"acme","name":"app","clone":".","checks":[{"name":"ok","command":"sh","args":["-c","echo ok"]}]}}'
```

State lives in `$EFFECTORY_HOME/state.sqlite` (default `~/.effectory`), keyed by collection and scope rather than by checkout, so every clone and worktree shares one history.

## Layout

| Path | Contents |
| --- | --- |
| `effectory.ts` | The collection root: workflows, Actions, Resource types, Targets, Triggers, and the Layers that provide them. |
| `workflows/` | `verify-pr`, `review-branch`, `implement`, `smoke`, and their tests. |
| `packages/core` | `@effectory/core`: primitives, planner, engine, SQLite state, test harness. |
| `packages/std` | `@effectory/std`: `Process`, `Shell`, `Agent` (Claude/Codex), `T3`, `Worktree`, `Service`, `Http`, `GitHub.PullRequestComment`. |
| `packages/cli` | `@effectory/cli`: the `effectory` command. |
| `AGENTS.md` | Guidance for coding agents working in this collection. |

## Writing a workflow

```ts
import { Assert, Each, Lifetime, Output, Workflow } from "@effectory/core";
import { GitHub, Shell, Worktree } from "@effectory/std";
import { Effect, Schema } from "effect";

export const verifyPr = Workflow.make(
  "verify-pr",
  {
    description: "Check out a PR, run its checks, assert, and post a summary.",
    input: Schema.Struct({ repo: Repository, pr: Schema.Int }),
    scope: ({ repo, pr }) => `${repo.owner}/${repo.name}#${pr}`,
  },
  Effect.fn(function* ({ repo, pr }) {
    const checkout = yield* Worktree("checkout", {
      repo: repo.clone,
      ref: `pull/${pr}/head`,
      fetch: { remote: "origin" },
    }).pipe(Lifetime.run);
    const results = yield* Each("check", repo.checks, (check) =>
      Shell(check.name, {
        cwd: checkout.path,
        command: check.command,
        args: check.args,
      })
    );
    yield* Each("passes", repo.checks, (check, i) =>
      Assert(check.name, {
        that: Output.map(results[i], (r) => r.exitCode === 0),
        message: `${check.name} failed`,
      })
    );
    yield* GitHub.PullRequestComment("summary", {
      owner: repo.owner,
      repo: repo.name,
      number: pr,
      body: Output.map(Output.all(results), render),
    });
  })
);
```

The body runs once per run, at plan time, with the decoded input as plain values. Node constructors return `Output`s; passing an Output into another node creates an edge. JavaScript `if` and loops cannot inspect Outputs: use `Output.map`/`Output.all`, the `when`/`runIf`/`allowFailure`/`dependsOn` node options, and `Each`.

### Primitives

| Primitive | Use |
| --- | --- |
| `Action.make(type, { input, output, run, fake?, rerun?, retry? })` | An imperative, recorded step. Nonzero exits are data. `rerun: "on-change"` skips when the input digest matches the latest record; `retry: "never"` fails an interrupted attempt with `OutcomeUnknown` and opens a retry approval. |
| `Resource.make(type, { props, attributes })` + `Provider.effect/succeed/dual` | Converge external state: `read`, `diff`, `reconcile`, `delete`, `checks`. Identity is (collection, scope, FQN), so reruns update instead of duplicating. `Lifetime.run` deletes it when the run finishes; `adopt` takes over `Unowned` objects. |
| `Each(name, items, f, { concurrency })` | Fan out. Literal items show every child in the plan; an `Output` array expands at execution time. |
| `Call(name, workflow, input)` | Run another workflow as a node, namespaced under `name/`. |
| `Assert(name, { that, message, severity })` | Record an `AssertResult`; never stops the graph. `--fail-on` and `--junit` act on them. |
| `Approve(key, { title, review, when })` | Suspend until `effectory approval approve`, then `run resume`. |
| `Data.latest/versions(source, fqn, { scope })` | Read earlier records as Outputs. |
| `Secret(name)` | An `Output<Redacted<string>>` from the `SecretStore`; values never enter records. |
| `Target.make(workflow, name, preset)` | A named input preset: `--target`. |
| `Trigger.schedule/webhook` | Start runs from cron or webhooks under `effectory serve`. |
| `Report.make`, `Report.summary`, `Assert.junitReport` | Render a finished run into a recorded artifact. |
| `Test.run(workflow, input, { mode })`, `Test.provider(resource, cases)` | Run a whole graph against fakes; exercise a provider's lifecycle. |

## How runs execute

1. **Plan.** Decode the input, run the body with a collecting registry, and build an `effect/Graph` (cycles rejected). `--plan` asks Resources to `read`/`diff` and on-change Actions to compare digests; nothing is changed.
2. **Execute.** One fiber per node, each awaiting its upstreams' Deferreds; a semaphore bounds concurrency. Each node goes `pending → running → succeeded | failed | skipped | suspended`, with the intent written before acting and the terminal status plus an immutable record after.
3. **Resume.** Succeeded Actions return their records; Resources re-converge; interrupted Actions rerun (or fail with `OutcomeUnknown` under `retry: "never"`); suspended approvals check for a decision. Resuming under a different collection revision (a hash of the collection's source graph and `bun.lock`) is refused.
4. **Finish.** Run-lifetime Resources are deleted, reports rendered, and the exit code computed (0 succeeded, 1 failed or failing assertions at `--fail-on`, 2 suspended).

## CLI

```text
effectory run <workflow> [--input k=v]... [--input-json JSON] [--target name] [--mode live|fake]
                         [--plan [--mermaid]] [--fail-on low|medium|high|none] [--junit[=file]] [--json]
effectory run resume|inspect|cancel <run-id>      effectory run list [--workflow] [--status]
effectory approval list | approve <id> | reject <id> [--note]
effectory action run <Action> [--input-json JSON] [--mode fake]
effectory data latest|versions <fqn> --scope s    effectory data query [--kind] [--where 'exitCode != 0'] [--since 7d]
effectory resource list [--scope] | delete <fqn> --scope s
effectory describe [--json]                       effectory serve [--port 8787]
```

Every command takes `--collection <file|dir>` (default `./effectory.ts`) and `--state <file>`. Run and approval ids accept unique prefixes.

## Development

```sh
bun run typecheck && bun run check && bun test   # or: bun run verify
```

Tests never reach live services: providers have fakes (`Provider.dual`, `Provider.memory`, an in-memory GitHub API), Agent Actions have fake answers, and process tests spawn local commands only.

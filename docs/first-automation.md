# First automation

Effectory discovers runnable definitions under `.effectory/automations/<name>/index.ts`. The health-check demo composes typed Tasks, checks loopback endpoints with bounded concurrency, and publishes observations and a summary.

## Initialize the workspace

```sh
bun install --frozen-lockfile
bun run effectory init
```

`init` creates or validates `.effectory/workspace.json`. Runtime commands open and close their local runtime automatically. Pass `--workspace <path>` to use another directory.

## Start the local fixture

In another terminal:

```sh
bun -e 'Bun.serve({ hostname: "127.0.0.1", port: 4311, async fetch(r) { const p = new URL(r.url).pathname; if (p === "/slow") await Bun.sleep(1500); return new Response("fixture", { status: p === "/unhealthy" ? 503 : 200 }); } })'
```

## Submit and inspect a run

```sh
bun run effectory workflow list
bun run effectory workflow describe health-check
bun run effectory workflow run health-check --input .effectory/automations/health-check/inputs.json --request-key first-run
bun run effectory run list
bun run effectory run inspect <run-id>
bun run effectory artifact list --run <run-id>
bun run effectory artifact get <artifact-id>
```

`workflow run` blocks until success, failure, cancellation, or an approval pause and prints the run record. Failure and cancellation exit nonzero. Use a new request key for a new measurement. Retrying the same key reuses the accepted run; changing its input or revision is refused. HTTP failures and timeouts are observations in the summary. Invalid input and storage failures fail execution.

After a crash, `effectory run resume <run-id>` recovers committed activity outcomes and continues unfinished work. Ctrl+C and SIGTERM request cancellation and wait for cooperative interruption. Use `effectory run cancel <run-id>` to request cancellation explicitly. External side effects still require idempotency or reconciliation.

## Approve a local action

```sh
bun run effectory workflow run approved-health-check --input .effectory/automations/approved-health-check/inputs.json --request-key reviewed-run
bun run effectory approval list
bun run effectory approval inspect <approval-id>
bun run effectory approval approve <approval-id>
bun run effectory run resume <run-id>
```

The approved demo persists the exact report plan, waits for review, then publishes a run-specific file without overwriting conflicting bytes. Approval records a decision; it does not execute the remaining steps. `run resume` refuses undecided gates and blocks while continuing approved work. Interactive approval shows the plan and asks for confirmation. Noninteractive callers must provide the exact reviewed `--digest` and `--revision`. Rejection fails the gate; cancellation prevents late approval from authorizing its action.

Use `approval reject <approval-id> --reason "Revise the plan"` to reject. Approvals and decisions survive CLI exit and restart. Unfinished executions require their original source revision, so restore the original code and lockfile if the runner refuses a changed task.

See [the authoring guide](authoring.md) for `Task.make`, `Automation.define`, publication, approval, and dependency injection. The [architecture](automation-platform.md) records runtime guarantees and deferred capabilities.

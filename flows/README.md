# Demo flows

These flows use `@effectory/flow` on this repository itself. [`flow.run.ts`](../flow.run.ts) lists them, and the `flow` command runs them (`bun run flow …`). Runs are kept in `.effectory/runs.db`.

## `Verify`: check the repository with its own tools

[`verify.ts`](verify.ts) runs `bun run typecheck`, `bun run check` and `bun test` as separate `Check` nodes through the `Shell` service in [`tools.ts`](tools.ts).

```sh
bun run flow run Verify --input '["typecheck","lint"]'
```

| Feature | Where |
| --- | --- |
| A node per check, run in parallel | `Verify` plans one `Check` per name with `After` |
| A concurrency limit | `Check` has `concurrency: 2` |
| A timeout | each `Check` attempt has 5 minutes |
| Retries | a failing `test` check runs once more, a second later |

A failing check doesn't fail `Verify`; it reports `passed: false`, so you see every result.

## `Release`: verify, confirm with a person, cool down, publish

[`release.ts`](release.ts) gates a release on `Verify`, reads the commit with `git`, asks a person, waits out a cooldown, then writes notes and announcements under `.effectory/releases`.

```sh
bun run flow run Release --input '{"version":"0.1.0","checks":["typecheck","lint"],"cooldownSeconds":5}'
# Run … is waiting for: ConfirmRelease({…,"sha":"…","subject":"…"})
bun run flow resume <run> --respond '{"_tag":"Ship","by":"you"}'
bun run flow status <run> --mermaid
```

| Feature | Where |
| --- | --- |
| A static dependency on another flow | `Release` runs after `Verify` and `HeadCommit` |
| A person's decision | `ConfirmRelease` is an Input; `Stop` blocks the release |
| A durable timer | `Cooldown` waits `cooldownSeconds`; over a minute, the run suspends until it wakes |
| Capped calls | `Publish` (at most once) and `Announce` (at most twice, with retries) |
| What ran | `flow status <run> --mermaid` draws the graph the run followed |

Pass `"checks": []` to skip verification.

## `Implement`: plan with agents, approve, implement

[`ship.ts`](ship.ts) loops a planning agent and a reviewing agent until the plan is approved, then asks a person, then implements. The agents are fakes (`AgentsFake`): the reviewer asks for tests until the plan mentions them.

```sh
bun run flow run Implement --input '"dark mode"'
bun run flow resume <run> --respond '{"_tag":"Revise","notes":"and docs"}'
bun run flow resume <run> --respond '{"_tag":"Approve","by":"you"}'
```

`Draft` retries and times out like a real agent call would.

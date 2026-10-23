# Working in the Effectory collection

This repository is an automation collection: typed workflows that act on other repositories and services. `effectory.ts` lists everything; `workflows/` holds the workflows; `packages/core` is the runtime and `packages/std` the standard library.

## Extend before you script

When asked to automate something, **extend an existing workflow or Action before writing a script.** Do not add shell scripts, one-off `bun -e` programs, or ad-hoc state files.

1. Discover what exists: `bun effectory describe --json` lists every workflow, Action, Resource type, and Target with JSON Schemas.
2. If a workflow nearly fits, add a node to it or a Target preset for it.
3. If a step is missing, write an `Action` (imperative, recorded) or a `Resource` + `Provider` (anything that creates or changes external state and must converge: comments, branches, worktrees, processes). Register it in `effectory.ts`.
4. Run it alone first: `bun effectory action run <Type> --input-json '{...}' --mode fake`.

## Rules of the model

- A workflow body runs once, at plan time. Node constructors return `Output`s; JavaScript `if` and loops cannot inspect them. Use `Output.map`, `Output.all`, `when`, `runIf`, and `Each`.
- An Action's nonzero exit or unhealthy response is data. Decide with `Assert` and `when`, not by failing.
- Anything external that must not be duplicated is a Resource (stable identity: collection, scope, FQN) or an Action with `retry: "never"`.
- Secrets come from `Secret(name)`; never put secret values in inputs or records.
- Give Actions and Providers a fake (`fake:` on the Action, `Provider.dual`) so workflows run with `--mode fake` and in tests.

## Checking your work

```sh
bun run typecheck && bun run check && bun test
bun effectory run <workflow> --plan --input-json '{...}'
bun effectory run <workflow> --mode fake --input-json '{...}'
```

Tests use `Test.run(workflow, input, { mode: "fake" })` and `Test.provider(...)` from `@effectory/core`; they must not reach live services.

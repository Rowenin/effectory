# Effectory

Starting fresh. Earlier design notes live in [`docs/`](docs/).

## Flows

[`@effectory/flow`](packages/flow/README.md) defines Tasks and runs them as durable graphs. This repository's flows are listed in [`flow.run.ts`](flow.run.ts); run them with the `flow` command:

```sh
bun run flow tasks
bun run flow run Implement --input '"dark mode"'
bun run flow resume <run> --respond '{"_tag":"Approve","by":"you"}'
```

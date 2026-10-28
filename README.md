# Effectory

Starting fresh. Earlier design notes live in [`docs/`](docs/).

## Flows

[`@effectory/flow`](packages/flow/README.md) defines Tasks and runs them as durable graphs. This repository's flows live in [`flows/`](flows/README.md) and are listed in [`flow.run.ts`](flow.run.ts); run them with the `flow` command:

```sh
bun run flow tasks
bun run flow run Verify --input '["typecheck","lint"]'
bun run flow run Release --input '{"version":"0.1.0","checks":["typecheck"],"cooldownSeconds":5}'
bun run flow resume <run> --respond '{"_tag":"Ship","by":"you"}'
bun run flow status <run> --mermaid
```

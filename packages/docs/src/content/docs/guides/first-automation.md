---
title: Your first automation
description: Define a typed greeting, publish its output, and inspect a durable run.
---

Complete [getting started](/guides/getting-started/) first. Run the following commands from the repository root; the SDK currently resolves from this workspace rather than a published package.

## Define the task

Create `.effectory/automations/greet/index.ts`:

```ts
import { Automation, Task } from "@effectory/sdk";
import { Effect, Schema } from "effect";

const greet = Task.make({
  name: "greet",
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  error: Schema.Never,
  run: ({ name }) => Effect.succeed(`Hello, ${name}`),
});

export default Automation.define({
  name: "greet",
  description: "Publish a greeting",
  input: Schema.Struct({ requestId: Schema.String, name: Schema.String }),
  success: Schema.String,
  error: Schema.Never,
  idempotencyKey: (input) => input.requestId,
  execute: (input) =>
    Effect.gen(function* () {
      const message = yield* greet({ name: input.name });
      yield* Automation.publish("greeting", {
        schema: Schema.String,
        value: message,
      });
      return message;
    }),
});
```

The automation name must be unique and use lowercase kebab-case. `Task.make` describes a named step whose result is recorded. `Automation.define` composes the workflow, and `Automation.publish` saves a named, schema-validated artifact.

Create `.effectory/automations/greet/inputs.json`:

```json
{ "requestId": "greeting-1", "name": "Ada" }
```

## Run and inspect

Register the new automation in root `effectory.run.ts`: add an import for `greet` from `"./.effectory/automations/greet/index.ts"`, then append `greet` to the existing `workflows` array. Keep the existing registrations and service layers.

Check the code, then run the task. Each command opens and closes its local runtime automatically.

```sh
bun run typecheck
```

From the repository root:

```sh
bun run effectory workflow describe greet
bun run effectory workflow run greet --input .effectory/automations/greet/inputs.json --request-key greeting-1
bun run effectory run list
```

Execution blocks until completion and returns a run record. Use that value in place of `<run-id>`:

```sh
bun run effectory run inspect <run-id>
bun run effectory artifact list --run <run-id>
```

The completed run returns `Hello, Ada` and publishes a `greeting` artifact. Approval gates pause durably; approval records a decision and explicit `effectory run resume <run-id>` continues execution.

## Understand replay

Use a new request key for a new execution. Retrying an accepted key with identical input and revision returns the existing admission; changing its input or revision is refused. The CLI request key is separate from the payload's `requestId`.

When calling the same Task multiple times in one workflow, give each logical invocation a stable key, such as `greet({ name: "Ada" }, { key: "ada" })`. Reusing an activity name and key reuses its persisted outcome even if arguments differ.

Completed Tasks survive runner restart. External side effects still need their own idempotency or reconciliation: a process can stop after an action happens but before its result is persisted. Unfinished runs require their original source revision and lockfile. See [architecture](/guides/architecture/) for these boundaries, and [getting started](/guides/getting-started/#approve-a-local-action) to try durable approvals.

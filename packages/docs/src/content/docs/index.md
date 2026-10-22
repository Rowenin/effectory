---
title: Effectory
description: Offline automation built with Effect.
---

Effectory is an offline automation runtime built with Effect. Configure operations, execute them, and inspect local run history without an account or hosted backend.

## Start building

- [Get started](/guides/getting-started/) with a local operation.
- [Write your first automation](/guides/first-automation/) with the Effectory SDK.
- [Explore the architecture](/guides/architecture/) and execution boundaries.

## Read with an AI assistant

Give your assistant [the documentation index](/llms.txt), or load [the complete documentation](/llms-full.txt) directly into its context. An [abridged version](/llms-small.txt) is available for smaller context windows. These plain-text files are generated from the same maintained pages on every build.

## Contribute

Documentation lives with the code in `packages/docs/src/content/docs/`. See [maintaining the docs](/guides/documentation/) for local preview and verification.

## Current scope

The default Effectory CLI runs local typed Effect workflows with SQLite persistence, loads explicit workflow registrations from root `effectory.run.ts`, stores named JSON artifacts, and accepts durable approval decisions. The supplied health-check and approved-health-check tasks use loopback endpoints. Operations may explicitly use a network; the runtime does not contact Factory services.

The CLI owns local execution until completion or an approval pause. Completed activities survive restart; approval records a decision and explicit resume continues execution. Secrets, scheduling, remote workers, local agent handoff, and a browser console are later increments.

---
name: effectory-build
description: Build, test, and troubleshoot Effectory tasks and durable workflows using the project's installed SDK and CLI.
---

# Build with Effectory

Read the project's instructions and existing definitions first. Identify the installed SDK and host with `effectory version` and `effectory doctor sdk`. Use their actual declarations and CLI help when a signature is uncertain; historical proposals are not API documentation.

For a new task or workflow, read [authoring](references/authoring.md), which includes a complete application and test. For retries, waits, process lifecycle, resources, or recovery, read [runtime boundaries](references/runtime.md).

For task-local Layers, typed tag reads, artifact publication/consumption and chained task tests, read [invocation services and artifact tests](references/composition.md).

For credential providers, memory-vault substitution, typed secret errors and source-outcome report tests, read [vaults and reports](references/vaults-and-reports.md).

For recorded assertions, severity thresholds and check-history/JUnit inspection, read [checks and task outcomes](references/checks.md).

Use ordinary Effect services and Layers for dependencies. Prefer the SDK's injected services: `Tag` definitions expose `.value()`, artifacts use `ArtifactStorage` and `ArtifactReader`, and vault definitions are their own services. Declare typed errors that should participate in the task's retry policy. Do not wrap Effect-native integrations in Promises; use Alchemy Distilled for supported third-party operations.

Preserve accepted run identities and request keys when observing or resolving an uncertain submission. A disconnected CLI is not proof that a run was never admitted. Inspect recorded state before deciding to retry or authorize re-execution.

Validate changes with the project's own checks. `Task.test` verifies handler behavior and supplied services; it does not prove durable restart, scheduling, or workflow coordination. Use a disposable repository for runtime experiments. Report which behavior was actually exercised and which remains unverified.

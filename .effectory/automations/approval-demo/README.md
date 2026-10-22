# Approval and pause demo

Run these commands from the repository root. No server or HTTP fixture is needed.

```sh
bun run effectory task run approval-demo --input .effectory/automations/approval-demo/inputs.json
```

The command publishes `prepared-message`, creates an approval request, then exits with a run record whose status is `suspended`. Copy its `id` as `<run-id>` below. The workflow is durably paused; no process stays running.

```sh
bun run effectory artifact list --run <run-id>
bun run effectory approval list
bun run effectory approval inspect <approval-id>
```

Choose the approval whose `runId` matches your run. Its review shows the exact message to publish. Approve from an interactive terminal:

```sh
bun run effectory approval approve <approval-id>
```

This records approval and leaves the workflow paused. Inspecting the run still shows `suspended`, and only the prepared artifact exists:

```sh
bun run effectory run inspect <run-id>
bun run effectory artifact list --run <run-id>
```

Continue the workflow explicitly:

```sh
bun run effectory run resume <run-id>
bun run effectory artifact list --run <run-id>
```

The run succeeds and returns the message. Both `prepared-message` and `completed-message` are now stored. The completed artifact is created only after approval and resume.

For a noninteractive approval, pass `--digest <digest> --revision <revision>` using the exact values from `approval inspect`. To reject instead, run `bun run effectory approval reject <approval-id> --reason "Revise the message"`; rejection marks the run failed without publishing the completed artifact.

Each `task run` invocation generates a fresh request key. To retry the same submission, supply the same explicit `--request-key` on each attempt. Keep the workflow source unchanged while a run is unfinished.

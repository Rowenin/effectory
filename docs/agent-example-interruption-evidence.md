# Installed advanced examples under process interruption

The exact composition and vault/report applications installed by `agent setup` were exercised under SIGKILL with the certified Darwin ARM64 executable. This supplements their earlier graceful-restart evidence. No application instrumentation, task gate, alternate provider or production change was introduced.

For each disposable project the driver used the real CLI to initialize it and install both Codex and Claude Code guidance. It checked healthy agent status and byte equality between both installed references and the shipped reference. The application was extracted directly from the first TypeScript fence, then executed by the daemon. This proves the installed content used in the exercise; it does not prove that either agent discovered or followed it.

The driver submitted 24 requests through the real RPC client. It observed committed runtime rows, stopped the daemon process, verified unfinished work remained, and killed and awaited that process. Restart used the identical executable and source. All submission keys were replayed, including any whose response could have been lost during shutdown. Synthetic repositories, key files and input files were removed after all child processes exited.

## Composition

At interruption, 21 runs were Running and three had Succeeded. Restart retained accepted run IDs, pinned revisions and completed results. All 24 runs ultimately succeeded with their respective input counts and `team: "platform"`. Exactly 24 artifact versions existed afterward, so re-entry did not duplicate publication versions. Seven idempotent attempts entered twice; 41 entered once.

This exercises the real task-local tag dependency, producer publication, reference handoff and consumer read in the exact example. It does not demonstrate external client cleanup: the example deliberately uses an in-memory client with a no-op lifecycle callback in its application binding.

## Vault and reports

The local vault held only a synthetic canary, with its plaintext input and key directory outside the project. At interruption there were 28 admitted runs (14 Succeeded, 11 Running, three Queued) and 24 report records: ten WaitingSource, 13 Queued and one Running.

After restart all 24 credential-check runs and all 24 report runs succeeded. Every existing report ID, group, generation and non-null report-run ID was retained. Every report returned `Succeeded` and `credentialsPresent: true`. Repeating the original vault put returned the original version with `replayed: true`. A scan of all 31 regular files in the stopped project found no synthetic plaintext. All 48 final task attempts had one recorded entry; the interrupted running report did not require a second handler entry.

This is local-provider, report admission/continuation and stored-content evidence. It is not a claim of killing a particular instruction inside the vault decoder or report handler, nor evidence for a remote provider or arbitrary secret transformations.

## Reproduction identity

- Executable SHA-256: `02c99046b503871a62a6b50c579ad83ba8e2ade44ae3ad78b80ce72029a058d0` (the [certified release candidate](runtime-upgrade-certification.json)).
- Driver: `/tmp/effectory-agent-interruption/proof.mjs`, SHA-256 `0ba91c5044bffa41f275d2e9f87442beddcc6af3d6c54c490c89c7adc5267791`.
- Composition application: `3445d492eba30b4e5c9605f818861d6436638582577063fae324eed276f852c0`; installed reference: `f7cbc78f47232c22e8062328c1b83f51a76f9e7137906398b84ae3f36f004b99`.
- Vault/report application: `cb579c5f67415f38f2e4c6b5c067ab13736ba79b96c80f5c0f8975b530c8bb12`; installed reference: `0f60e5540a6147c1762fdc3575bfa9aa08a8cb0001100d51b98660523d34b9bb`.
- Result files: `/tmp/effectory-agent-interruption/composition-result.json` (`4104f32e71f412b3b500666f5247468ae08a6d0a6562fd9ebbdc14e06197c6cf`) and `vaults-and-reports-result.json` (`d7e6bdbdee514237c747104ca81386109a348a56122bb85e497104beaf217f21`). They retain pre-kill rows, final rows and public replies. The final driver exited 0. Its first exploratory run reached recovered composition outcomes but used an incorrect lake table name in a final assertion; that scratch-driver error was corrected before rerunning both cases.

No real credential, external mutation, registry installation or authenticated agent session was used. The examples' existing typecheck/task-test results remain separate. The broader source suite subsequently passed 711 tests with zero failures alongside typecheck and formatting/lint; the [revision-lifecycle evidence](revision-activation-shutdown-evidence.md) records its unchanged source snapshot. These executable exercises do not substitute for that suite or authorize another upgrade transition.

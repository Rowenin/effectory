# Swamp agent calls and standard Effectory activities

Effectory should ship reusable agent activities over `Activity.define`: a general agent call, schema-validated generation, and code review. Provider adapters should translate those requests into CLI execution; Effect should continue to own persistence, concurrency, interruption, and retry composition. A shared process operation supplies the execution foundation.

`@effectory/activities` now supplies `Process` and `Agent` as services, configured once in `effectory.run.ts` and callable only inside Tasks; see the [authoring contract](../authoring.md#run-coding-agents). The implemented API differs from the proposal below. Effectory ships only the `run` and `generate` primitives; review is a composite Task that users define from them (`.effectory/automations/review-branch`). Executable identity is not yet recorded. HTTP checks stay in the shared automation example.

## How Swamp calls agents

Swamp puts agent execution in the [`@swamp/agent-runner` extension](https://swamp-club.com/extensions/%40swamp/agent-runner), rather than in its workflow engine. The extension has two methods: arbitrary prompt execution and structured code review. Its providers are Claude Code and Codex CLIs, not direct model API clients.

The inspected source is [swamp-extensions at `7ed7656`](https://github.com/swamp-club/swamp-extensions/tree/7ed76560133f3f9302ab0058313141be2f2276aa/agent-runner). The registry lists extension version `2026.10.17.3`; the behavior identifies itself as `2026.10.17.1`.

The call path is:

1. A configured behavior selects a provider, pinned CLI version, authentication mode, and optional default model. Calls supply the prompt or review inputs and optional model/effort overrides.
2. The shared runner resolves authentication, ensures the binary exists in a workspace cache, builds provider arguments, and starts a subprocess with explicit environment forwarding and the caller's abort signal.
3. The provider owns download/install details, argument translation, authentication environment naming, and instructions for capturing its final output.
4. `run` writes a versioned result resource containing stdout and exit code. `review` builds a prompt, collects JSON from a temporary file or output text, validates its shape, and writes a review result resource. Resources carry provider/model/effort tags for inspection.

The separation is visible in the [behavior methods](https://github.com/swamp-club/swamp-extensions/blob/7ed76560133f3f9302ab0058313141be2f2276aa/agent-runner/extensions/models/agent_runner.ts), [runner](https://github.com/swamp-club/swamp-extensions/blob/7ed76560133f3f9302ab0058313141be2f2276aa/agent-runner/extensions/models/_lib/runner.ts), [provider contract](https://github.com/swamp-club/swamp-extensions/blob/7ed76560133f3f9302ab0058313141be2f2276aa/agent-runner/extensions/models/_lib/types.ts), and [review implementation](https://github.com/swamp-club/swamp-extensions/blob/7ed76560133f3f9302ab0058313141be2f2276aa/agent-runner/extensions/models/_lib/review.ts).

Review profiles store a prompt path, default model, tool configuration, and requested access mode. Inline diffs avoid asking the agent to explore the repository to discover changes. General execution and review share the same subprocess runner. These are useful patterns to carry into Effectory.

## Semantics Effectory should strengthen

Swamp's inspected runner logs a nonzero exit and returns it as data. General execution persists that result; review attempts to parse output without first rejecting the exit code. Effectory's agent activity should fail on unsuccessful execution, even when partial text looks valid. A low-level process operation may return exit codes as observations, but an agent result must distinguish completed work from failed execution.

The review schema checks the shape of verdict, findings, and highest severity. Their consistency is requested in the prompt rather than computed by the parser. Effectory should derive verdict and maximum severity from validated findings using an explicit threshold. A malformed response should be an execution error, distinct from a completed review that found problems.

The shared `readOnly` request is not enforced uniformly. The [Claude adapter](https://github.com/swamp-club/swamp-extensions/blob/7ed76560133f3f9302ab0058313141be2f2276aa/agent-runner/extensions/models/_lib/providers/claude.ts) translates configured tool lists but does not inspect that flag. The [Codex adapter](https://github.com/swamp-club/swamp-extensions/blob/7ed76560133f3f9302ab0058313141be2f2276aa/agent-runner/extensions/models/_lib/providers/codex.ts) derives a default sandbox from it, but allows a provider configuration override. Effectory should validate requested access against adapter capabilities and reject unsupported combinations before starting a process. Tool restrictions alone do not establish OS isolation.

The runner collects complete stdout and stderr and supplies an abort signal, with no runner-owned timeout or output cap. Effectory needs bounded streams and a deadline, including cleanup when collection fails. Long logs cannot fit the current bounded JSON artifact store; initially reject oversized results and retain only explicitly bounded diagnostics.

Swamp automatically downloads missing binaries during execution. Effectory's [offline boundary](../automation-platform.md#offline-boundary-and-extension-trust) calls for installed, explicitly configured executables instead. Installation and updates should be separate operations. Authentication should resolve at execution time from a configured environment reference or supported CLI login, with no raw key in activity inputs or results.

## Proposed package and operations

Use `@effectory/activities` for standard implementations, depending on `@effectory/sdk` and Effect platform services. Keep `@effectory/sdk` responsible for defining activities and automations; keep CLI provider details out of the runtime engine.

Start with these operations:

- `Process.run` (implemented): executable plus argument array, explicit working directory/environment policy, stdin, timeout, and output limits. It returns bounded stdout/stderr, exit code, and duration. Nonzero exits fail. It owns subprocess scope and cancellation. Shell interpretation requires an explicit shell executable. See the [authoring contract](../authoring.md#run-a-process).
- `Agent.run`: configured provider, prompt, model, provider-specific reasoning options, requested access, and execution limits. It returns the final answer with provenance, separately from diagnostics; nonzero exit is a typed failure. Provider output parsing must distinguish final messages from event streams.
- `Agent.generate`: the same execution path with an Effect output schema. Decode the JSON wire value through that schema inside the durable activity, before recording success. Prefer supported structured output channels; reject malformed output rather than searching arbitrary logs for plausible JSON.
- `Agent.review`: a specialization of generation accepting a captured diff or explicit file set and review instructions. Return validated findings and a deterministic verdict. Finding severity, source location, explanation, and suggested remediation form the common contract.

Expose durable activities using `Activity.define` and compose them in the automation. New operations are activities. Activities that wrap a CLI, such as `@effectory/t3`'s `Thread.start`, call `Process.exec` inside their own `execute` so running and decoding the command is one recorded step. Background servers and watchers need a separate managed lifecycle and are outside the initial implementation.

Provider adapters should declare supported access modes, authentication modes, output channels, and reasoning options. Validate adapter-specific configuration instead of accepting an untyped bag of flags. Keep CLI backends distinct from future direct model API backends: tool execution, workspace access, sessions, and cancellation differ materially.

## Proposed authoring contract

The following illustrates the intended API; these imports and helpers do not exist yet:

```ts
import { Agent } from "@effectory/activities";
import { Automation } from "@effectory/sdk";

// Construct once from installed provider configuration.
const reviewer = Agent.reviewer({
  name: "code-review",
  provider: configuredProvider,
  access: "read-only",
  timeoutMs: 300_000,
  maxOutputBytes: 128 * 1024,
  failOn: "high",
});

// Inside Automation.define.execute:
const review =
  yield *
  reviewer(
    { instructions: reviewInstructions, diff: capturedDiff },
    { key: "review-proposed-change" }
  );
yield *
  Automation.publish("review", { schema: Agent.ReviewResult, value: review });
```

The provider configuration selects an installed executable and supported authentication without embedding credentials. The invocation key follows existing SDK semantics: the same key reuses a committed result even if the prompt changes. Use a new stable key for each logical review round, and a new run for a fresh measurement. Persist or capture repository revision, diff, instructions, and nonsecret effective configuration so results can be tied to the work actually reviewed. Mutable prompt files must be read within the durable operation or captured by an earlier activity, not reread during workflow replay.

Record requested and reported model/version separately when a provider cannot prove the resolved value. Include provider, executable identity, workspace revision, requested access, and available usage metadata. Do not persist credentials or entire inherited environments. Publish results explicitly through `Automation.publish`; persistence of an activity result alone does not make it a named artifact.

## Recovery and implementation sequence

A completed agent activity replays its committed result. A crash after dispatch but before commit can repeat a paid call and any agent side effects. A stable Effectory activity key is not an external provider idempotency key. Begin with read-only analysis; add write-capable agents only with a tested reconciliation policy. Existing approval helpers can gate subsequent actions using the captured review.

Implement in three increments:

1. Implement the scoped process activity first, with tests for success, nonzero exit, timeout, cancellation, output overflow, and durable replay. Provider adapters follow as separate work. No paid calls are needed for these tests.
2. Add generation and review inside stable activity boundaries. Test schema wire decoding, deterministic verdicts, distinct invocation keys, and replay across runner restart without repeating a committed call.
3. Add the second CLI adapter and an automation that reviews a captured diff and publishes its result. Exercise that automation through normal task discovery and the CLI.

The [fingerprinter](../../packages/runtime/src/fingerprint.ts) resolves both `@effectory/sdk` and `@effectory/activities`, including transitive source and package metadata. External executables are outside that source graph: process replay reuses a committed result, but an uncommitted call uses the executable currently installed. Recording executable identity and defining version-change reconciliation remain requirements for future agent adapters.

This gives Effectory a reusable operation library while retaining the current execution model. Scheduling, workflow routing, retries, approvals, and concurrency remain ordinary Effect/Automation composition rather than becoming features of an agent-specific engine.

# Agent runner

`offtree/agent-runner` contributes one `RunSession` task for OpenCode, Claude Code, Codex, and application-supplied adapters. It runs one noninteractive prompt or an explicit continuation and publishes a normalized result. The task uses manual replay because agent tools can perform external actions before an interruption.

Install directly from the repository, choosing a committed tag, branch or commit:

```sh
effectory extension add github:Rowenin/effectory@<tag-or-commit> \
  --path extensions/agent-runner --as Agents --trust
```

The installer resolves the ref to a commit, checks out that commit, installs frozen dependencies with lifecycle scripts disabled, and builds the bundle and declarations. Commit `effectory.extensions.lock.json` with your application. On another computer, use `effectory extension restore --trust` with Git, Bun matching the locked build version, and the same Effectory version. Private GitHub repositories use your existing `gh` login. Cached bundles restore offline. See [source installation](../../docs/extension-source-installation.md) for author metadata, toolchain requirements and explicit updates.

Prebuilt release archives remain available through `--asset effectory-agent-runner.tgz`; `bun run build:extension:agent-runner` builds that optional archive.

## Configure and compose

The installed descriptor exposes `Agents.tasks.RunSession` and `Agents.exports.layer`. Select the extension once and provide its runner through the application's Layer. The [repository example](../../examples/agent-runner/effectory.ts) demonstrates the same workflow using source imports.

```ts
import { BunServices } from "@effect/platform-bun";
import { Application, Extension } from "@offtree/effectory-sdk";
import { Effect, Layer } from "effect";

import { Agents } from "./effectory.extensions";

// Explicitly forward only the environment needed by the selected CLI.
// Read credentials through Vault here when your application uses API keys.
const environment = Effect.sync(() =>
  Object.fromEntries(
    ["HOME", "PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME"].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]]
    )
  )
);

export default Application.make({
  extensions: [Extension.use(Agents)],
}).provide(
  Agents.exports
    .layer({
      platforms: {
        claude: {
          kind: "claude",
          executable: "/absolute/path/to/claude",
          version: "<installed-version>",
          configuration: "local-claude-v1",
          environment,
        },
        codex: {
          kind: "codex",
          executable: "/absolute/path/to/codex",
          version: "<installed-version>",
          configuration: "local-codex-v1",
          environment,
        },
        opencode: {
          kind: "opencode",
          executable: "/absolute/path/to/opencode",
          version: "<installed-version>",
          configuration: "local-opencode-v1",
          environment,
        },
      },
      policies: {
        read: {
          claude: {
            allowedTools: ["Read", "Glob", "Grep"],
            disallowedTools: ["Bash", "Edit", "Write"],
          },
          codex: { sandbox: "read-only" },
          opencode: [{ permission: "read", pattern: "*", action: "allow" }],
        },
      },
    })
    .pipe(Layer.provide(BunServices.layer))
);
```

Inside an ordinary workflow builder:

```ts
const result =
  yield *
  graph.task("review", Agents.tasks.RunSession, {
    platform: "codex",
    policy: "read",
    workingDirectory: "/work/project",
    prompt: "Review the authentication module and describe any bugs.",
  });
```

Switch `platform` without changing the task. Optional `model` is passed unchanged; OpenCode requires `provider/model`. Optional `options` are native, validated fields: Claude `effort`, Codex `reasoningEffort`, and OpenCode `agent` / `variant`. Unknown keys fail before execution. Unsupported model-specific values may still be rejected by the native platform. No platform or model fallback is implicit.

Policies are explicit native controls, not equivalent security sandboxes. Claude limits the tool inventory, preapproves the allowed tools, and disables permission prompts; its ordinary project settings, hooks, skills and login remain active. Codex uses the configured sandbox and never requests interactive approval. OpenCode starts with deny-all session permissions and applies the configured allow/deny rules. Define a separate editing policy when required. No adapter enables a blanket permission bypass.

## Typed text and structured JSON output

Declare a task with `Agents.exports.makeTask` to choose its output schema. Plain `Schema.String` produces ordinary text. Every other schema requests native structured JSON. The task still accepts the same platform, prompt, model, policy, working directory and resume input.

```ts
import { Schema } from "effect";

export const Review = Agents.exports.makeTask({
  id: "code-review",
  version: 1,
  output: Schema.Struct({
    approved: Schema.Boolean,
    findings: Schema.Array(Schema.String),
  }),
});

// Register Review in Application.tasks and provide the normal runner Layer.
// In your workflow builder:
const review =
  yield *
  graph.task("review", Review, {
    platform: "claude", // also works with codex or opencode
    policy: "read",
    workingDirectory: "/work/project",
    prompt: "Review the changes and report your findings.",
  });
// review's output reference has { approved: boolean; findings: readonly string[] }.
```

The success envelope keeps the session, version, model and usage fields, with `output` inferred from the schema. Each generated task declares its own `${id}/result` artifact with that same typed envelope and contract version. Register the returned task once; the output schema belongs to its source declaration and pinned revision, not serialized task input. Change the task version when changing its persisted output contract. The existing `Agents.tasks.RunSession` remains a text task.

`format: "json"` explicitly requests a JSON string when `output: Schema.String`. `format: "text"` allows a refined or transformed string-encoded schema to consume ordinary text. Only the exact plain string schema defaults to text; annotated/refined strings default to JSON unless overridden. Schema codecs must not require encoding/decoding services, matching normal Effectory task boundaries.

Structured responses use an internal required `output` wrapper so arrays, numbers, booleans, null and strings work with platforms requiring an object at the root. This wrapper is removed before returning the typed result. Effect's canonical JSON codec supplies both the provider JSON Schema and local decoding, so transformations retain their decoded type while artifacts/history store the corresponding JSON encoding. Named and recursive definitions travel with the schema.

Claude receives `--json-schema` and its dedicated `structured_output` result is required; text is never used as a substitute. Both a single JSON result and a verbose message array from native settings are accepted. Codex receives `--output-schema` pointing at a private temporary file that is removed on success, failure or interruption. OpenCode receives Distilled's native `format: { type: "json_schema", schema, retryCount: 0 }` and must return `info.structured`. Explicit continuation passes the requested schema again. No application-level prompt repair or retry is performed.

Every response is decoded locally, including checks/refinements that JSON Schema cannot express exactly. Missing JSON, markdown-fenced JSON, invalid fields, excess properties or native structured-output failures produce a sanitized `InvalidStructuredOutput` and publish no successful result. Raw responses and schema diagnostics are excluded from these errors. Native platforms/models still impose their own JSON Schema subsets; for portable optional values prefer required nullable fields (`Schema.NullOr`) over optional keys. Unsupported native schemas fail rather than falling back to a prompt-only request. Provider schemas are bounded to 64 KiB; output and transcript byte limits continue to apply.

Custom adapters must declare `supportsStructuredOutput: true`, honor `AdapterRequest.outputSchema`, and return the serialized JSON wrapper in their `output`. Existing custom adapters continue to support text and reject structured requests before execution until they opt in.

## Authentication, versions, and integration choice

Binaries are installed by the operator. Claude/Codex versions are checked with `--version`; OpenCode's health response must match its configured version. The environment Effect resolves per invocation; its service requirements remain visible on the runner Layer, and failures become a sanitized Authentication error. Nothing is implicitly inherited from the daemon. Forward HOME/PATH and the appropriate XDG variables explicitly for stored logins and tool discovery. For API authentication, resolve secrets in this Effect and pass them as `Redacted` values under the native environment names. Credentials never belong in task inputs, platform options, or configuration IDs. Existing CLI login behavior is retained; the runner does not perform login or change credentials.

OpenCode uses `@distilled.cloud/opencode@1.0.0-rc.18` with the repository's pinned Effect 4.1.2. The published peer range is `^4.0.5`, which accepts 4.1.2. Tests exercise the actual SDK's health, create/get/update session, prompt, and abort operations against an authenticated local fixture server. Each invocation owns a private `opencode serve` process on a dynamic loopback port with a fresh server password. The same local session store allows later explicit continuation.

Concrete Distilled coverage limits: its `subscribeEvent` operation returns an untyped object rather than an Effect event stream, so this version uses typed JSON prompt/result operations and lifecycle progress only. The inspected [Distilled revision](https://github.com/alchemy-run/distilled/tree/d331b534c895af616c777243709d78ebf6de4c40/packages) has no Claude Code or Codex harness package; cloud inference operations would not execute their local tools or preserve their sessions/authentication. Those adapters therefore use Effect's `ChildProcessSpawner`, with bounded stdout/stderr and no shell. No Promise SDK or custom HTTP client is used. OpenCode automatic HTTP retries are disabled because resubmitting prompts can repeat actions.

The Swamp inspiration is its [agent-provider interface](https://github.com/swamp-club/swamp-extensions/blob/4cfc071d7151cc1e407556c19a2e0a44b68f1e37/agent-runner/extensions/models/_lib/types.ts): separate common execution from provider translation and preserve optional session/usage metadata. This is an independent implementation using Effectory contracts; no Swamp implementation code is copied.

## Results and lifecycle

Results include final text, platform/version, canonical working directory, optional session reference, requested/reported model, and reported usage. Unknown usage fields are absent. Usage is per invocation; OpenCode currently reports the final assistant message's usage rather than a whole-session aggregate. Every successful task publishes `result`. `retainTranscript: true` additionally publishes bounded CLI JSON events; for OpenCode this is a normalized terminal result, not a full conversation export. Task publications and results use Effectory's existing vault disclosure guards.

A successful result's `session` may be supplied as a later task's `resume`. Platform, policy name, configuration ID and canonical directory must match. Change the configuration ID when changing native policies, authentication mode, session storage, or other execution settings. References are local-machine handles and do not export a conversation. Sessions are not portable across platforms. Never select an implicit last session. Adapters that cannot resume declare `supportsResume: false`.

The runner rejects simultaneous invocations of the same canonical working directory within one shared service instance. Separate runner Layers or external agent processes require application-level coordination. Prefer separate caller-managed worktrees for parallel work.

Execution defaults to 15 minutes, a 512 KiB provider-output/transcript limit, 64 KiB stderr, and a 128 KiB final-response limit. Output-limit failures never silently truncate a result. Cancellation/timeout closes the owned process scope; the platform spawner terminates its process group with escalation after one second. OpenCode also attempts a bounded session abort before server shutdown. Interruption remains Effect interruption. Native processes that deliberately escape the process group are outside this guarantee. SIGKILL of the daemon cannot run finalizers and may leave an orphan process to inspect before recovery.

Malformed/missing terminal results, nonzero exits, denied permissions, version mismatch, unsupported options, capacity/authentication failures, timeouts and busy workspaces fail with `AgentError`. Raw diagnostic text is not logged or included in error messages. CLI capacity/authentication classification uses bounded diagnostics and is best effort; it never authorizes automatic retries. On daemon restart an uncertain invocation enters `NeedsAttention`, using [existing manual recovery](../../docs/manual-recovery.md). Recovery may repeat actions and does not automatically resume the provider conversation.

## Validation and limits

The tests use executable fixtures and the real Distilled client without paid model calls. They cover all three result/resume paths, invalid output, permission/capacity failures, output bounds, environment isolation, timeout/descendant cleanup, server abort, workspace locking, archive codec identity, emitted consumer types, real-daemon restart/manual recovery, native JSON requests and resume, scalar/array outputs, local schema/refinement validation, encoded transformations, temporary schema cleanup, and typed consumer inference. Live provider/model interoperability is not certified by these fixtures: use the exact native versions and flags supported by your installation, particularly Claude's `--permission-prompts none`. No provider CLI was downloaded or live LLM session started during implementation.

Interactive approvals, automatic binary installation, worktree creation, provider fallback, and specialized review verdicts remain outside this first version. Build those as separate capabilities or workflows rather than changing the general task contract.

# 1Password local CLI vault extension proposal

Deferred on 2026-11-07: the user prioritized runtime correctness, upgrades and V1 agent setup, with new extensions added only when needed. The local CLI preference and proposal below are retained for that future work. No approval is needed here to proceed with the runtime objective.

Status: the user selected Desktop/CLI authentication on 2026-11-07. The factory and behavior below are proposed for public API approval; no 1Password extension is implemented. This revision replaces the earlier service-account-first proposal. Feasibility evidence and its limits are in [the research record](onepassword-vault-research.md).

## Public shape

Installable extension: `offtree/onepassword-vault`. With an installed alias `OnePassword`, use existing `Vault.layer`:

```ts
Vault.layer(
  Credentials,
  OnePassword.exports.make({
    auth: "cli",
    account: "your-team.1password.com",
    secrets: { token: "op://Engineering/GitHub/token" },
    requestTimeout: "30 seconds",
  })
);
```

Register `Extension.use(OnePassword)` in the application, as with AWS. Task reads remain `yield* Credentials.get("token")`. Tests use existing `Vault.memory`. There is no new core runtime provider, task context field or administrative mutation command.

Proposed signature, not implemented SDK code:

```ts
interface Options {
  readonly auth: "cli";
  readonly account: string;
  readonly secrets: Readonly<Record<string, string>>;
  readonly requestTimeout?: Duration.Input;
}
make(options: Options): Vault.Implementation<DefinitionError>;
```

`account` is required and passed as `op --account`, accepting an account sign-in address or account ID. An explicit account avoids depending on the daemon user's selected default. It is not a credential. Options and mappings are copied/frozen; mapping keys must exactly match the Vault declaration. Account and reference values must be nonempty and have no surrounding whitespace; references must start with `op://`. Full reference syntax is resolved by `op` at read time, without a new Effectory selector language.

## Authentication and operation

The adapter runs the installed official `op` executable, resolved from the daemon's PATH. It uses the daemon's local OS user and CLI configuration. Desktop app integration is the recommended setup; an already established manual CLI session is also allowed. The adapter neither signs in nor collects a password, Secret Key or session token through its public API.

Desktop authorization may prompt in the local desktop session during a read. A locked, absent or inaccessible session can fail or time out. A daemon running under another OS user or without desktop access does not inherit the invoking user's interactive authorization. Manual session environment changes require restarting the daemon. stdin is closed; there is no terminal password prompt or automatic sign-in.

The child environment excludes `OP_SERVICE_ACCOUNT_TOKEN`, `OP_CONNECT_HOST`, `OP_CONNECT_TOKEN` and `OP_CONNECT_API_BASE_URL`, so this local mode cannot silently select hosted authentication. It retains local CLI configuration/session settings, including `OP_CONFIG_DIR`, `OP_SESSION` and account-specific session variables. Explicit `--account` wins over `OP_ACCOUNT`. Debug output is disabled and output encoding is forced to UTF-8. Do not expose credentials as command arguments or write them to temporary files.

Each read invokes `op read --no-newline` with an argument array and no shell. Empty strings and trailing newlines belonging to the secret are preserved. Query parameters supported by `op read` are delegated to the CLI; resulting values must still be UTF-8 text within the Vault raw-value limit. Effectory does not cache values; the CLI's own caching/session behavior still applies.

Import, factory creation, Layer acquisition and `vault describe` do not spawn `op`, authenticate or read a secret. Missing CLI/session errors happen at read time, so provider setup cannot prevent daemon startup and repair. Existing Vault rules reject reads during revision construction.

Distilled 1.0.0-rc.18 supplies Connect reads but no local CLI/desktop read operation in the inspected package. Using the official CLI is the documented coverage exception required by AGENTS.md. Keep process integration in this extension, using Effect's `ChildProcessSpawner` and a scoped Bun platform Layer. No Promise SDK wrapper, SDK Worker/WASM payload, custom HTTP client or new host service is needed for this path.

## Ownership and limits

- At most four reads execute concurrently per provided vault Layer; additional reads wait interruptibly. This is not a daemon-wide process limit.
- Default read timeout is 30 seconds, configurable to a finite positive duration of at most five minutes. It includes queueing, process startup and desktop authorization. Awaited cleanup can extend elapsed latency beyond the timeout.
- An Effect Scope owns each process. Concurrently drain stdout (retain at most 65,536 bytes), stderr (discard with an 8 KiB budget) and exit status. Overflow fails the read and terminates the process. No raw stderr or process error payload enters telemetry or Vault errors.
- Timeout, interruption and read failure terminate the child, with bounded escalation to a forced kill, and await process cleanup. Release the read permit after cleanup. Preserve caller interruption instead of converting it to a retryable error.
- Only accept stdout after exit code zero and both streams finish. Strict UTF-8 decoding and byte bounds precede returning the raw string. Existing `Vault.layer` supplies codec decoding and attempt secret protection.

## Proposed error behavior

The inspected CLI documentation/help does not establish a structured missing-secret error contract. Do not infer absence or authentication state by parsing human stderr. This deliberately differs from a provider with structured NotFound responses.

| Condition | Result |
| --- | --- |
| Invalid factory options or mismatched mapping keys | DefinitionError |
| CLI unavailable, nonzero exit, timeout or unclassified process failure | VaultUnavailable / Unreachable |
| Invalid UTF-8 output | VaultFailure / Corrupt |
| stdout or stderr budget exceeded | VaultFailure / LimitExceeded |
| Successful empty output | Present empty string, then normal Vault codec validation |

A missing remote item or field therefore fails the read; `getOption` does **not** return None for it. The adapter never turns a failed read into absence. This coarse classification also means an opted-in retry can retry a permanent CLI failure. Error text may identify the logical vault/key and suggest checking local CLI access, but must omit the upstream message, reference and secret. Remote failure distinctions can be improved only with a verified supported interface and a discussed contract change.

## Packaging and proof gates

The extension archive contains its code and Effect platform dependencies; `op` remains an external operator-installed prerequisite. The inspected local CLI is 2.33.1. A supported version floor must be established by compatibility tests rather than assumed from one installation. Retained revisions pin adapter code and configuration, not the external CLI binary or its session.

Before shipping, prove:

1. Generated facade typing, archive installation, retained revision loading and startup/describe without `op` or credentials.
2. A synthetic executable observes the explicit account and local environment, never receives Connect/service-account credentials, and preserves exact stdout including empty values and newlines.
3. Nonzero status, malformed UTF-8, oversized stdout/stderr, timeout, interrupted queueing and process cleanup produce bounded sanitized outcomes. No late result is accepted after cancellation.
4. Existing secret-output protection, memory substitution and isolation of concurrent vaults work with returned synthetic secrets.
5. Real compiled Effectory can spawn the external executable on supported platforms without requiring an external JavaScript runtime. Verify child/descendant cleanup guarantees rather than inferring them from a single synthetic child.
6. Repository typecheck, formatting/lint and tests pass. A real desktop authorization/read remains a separately authorized smoke test; synthetic process tests do not prove desktop approval behavior.

## Remaining public approval

The local Desktop/CLI direction is selected. Confirm the explicit `auth: "cli"` and required account, external CLI prerequisite, 30-second default/four-read per-Layer limit, and conservative failed-read semantics above before implementation. In particular, missing remote secrets fail `getOption` instead of returning None.

Connect, service-account authentication, remote writes/listing, refresh hooks and migration remain separate parity work. Connect should use Distilled when implemented. This read-only extension is not a claim of complete 1Password parity.

import type { Effect, Redacted, Schema } from "effect";

import type { AgentError, Input, SessionResult } from "./contracts.ts";

export interface Policy {
  readonly claude?: {
    readonly allowedTools: readonly string[];
    readonly disallowedTools: readonly string[];
  };
  readonly codex?: { readonly sandbox: "read-only" | "workspace-write" };
  readonly opencode?: readonly {
    readonly permission: string;
    readonly pattern: string;
    readonly action: "allow" | "deny";
  }[];
}
export interface AdapterRequest {
  readonly input: typeof Input.Type;
  readonly policy: Policy;
  readonly progress: (message: string) => Effect.Effect<void>;
  readonly outputSchema?: Schema.Json;
}
export interface Adapter {
  readonly configuration: string;
  readonly supportsResume: boolean;
  readonly supportsStructuredOutput?: boolean;
  readonly run: (request: AdapterRequest) => Effect.Effect<
    {
      readonly output: string;
      readonly version: string;
      readonly sessionId?: string;
      readonly reportedModel?: string;
      readonly usage?: typeof SessionResult.Type.usage;
      readonly transcript: readonly Schema.Json[];
    },
    AgentError
  >;
}
export interface Platform<R = never, E = never> {
  readonly kind: "claude" | "codex" | "opencode";
  /** Change whenever policy-relevant configuration, auth, or session storage changes. */
  readonly configuration: string;
  readonly executable: string;
  readonly version: string;
  /** Resolved per attempt. No implicit inheritance of the daemon environment. */
  readonly environment: Effect.Effect<
    Readonly<Record<string, string | Redacted.Redacted>>,
    E,
    R
  >;
}
export interface Options<R = never, E = never> {
  readonly platforms?: Readonly<Record<string, Platform<R, E>>>;
  readonly adapters?: Readonly<Record<string, Adapter>>;
  readonly policies: Readonly<Record<string, Policy>>;
  readonly timeoutMillis?: number;
  readonly maximumOutputBytes?: number;
}

import { terminal } from "@effectory/runtime/protocol";
import type { RunStatus } from "@effectory/runtime/protocol";
import type {
  Outcome,
  Status,
} from "@offtree/effectory-sdk/internal/report-history";
import type { Schema } from "effect";
import { Cause, Exit, Option } from "effect";

import type { ExecutionFailure } from "./execution-boundary.ts";

export interface InvocationFacts {
  readonly status: RunStatus;
  readonly fenced: boolean;
  readonly reason: ExecutionFailure | null;
}
export type NativeInvocation = Option.Option<
  | { readonly _tag: "Suspended" }
  | { readonly _tag: "PendingCompletion" }
  | {
      readonly _tag: "Complete";
      readonly exit: Exit.Exit<Schema.Json, ExecutionFailure>;
    }
>;
export type InvocationOutcome =
  | {
      readonly _tag:
        | "Pending"
        | "Suspended"
        | "Unresolved"
        | "NoNativeExecution";
    }
  | {
      readonly _tag: "Complete";
      readonly status: Status;
      readonly outcome: Outcome<Schema.Json, Schema.Json>;
    };

const failed = (): InvocationOutcome => ({
  _tag: "Complete",
  outcome: {
    _tag: "Failure",
    category: "Defect",
    detail: { message: "Task execution failed unexpectedly" },
  },
  status: "Failed",
});

/** The native result wins over a later root fence. Interrupts need final root facts. */
export function normalizeInvocation(
  state: NativeInvocation,
  facts: InvocationFacts
): InvocationOutcome {
  if (Option.isNone(state)) {
    return {
      _tag: terminal.has(facts.status) ? "NoNativeExecution" : "Pending",
    };
  }
  if (state.value._tag === "PendingCompletion") {
    return { _tag: "Pending" };
  }
  if (state.value._tag === "Suspended") {
    return { _tag: terminal.has(facts.status) ? "Unresolved" : "Suspended" };
  }
  const { exit } = state.value;
  if (Exit.isSuccess(exit)) {
    return {
      _tag: "Complete",
      outcome: { _tag: "Succeeded", value: exit.value },
      status: "Succeeded",
    };
  }
  if (Cause.hasDies(exit.cause)) {
    return failed();
  }
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isSome(error)) {
    const { category, detail, outcome } = error.value;
    if (category === "Domain") {
      return {
        _tag: "Complete",
        outcome: { _tag: "DomainFailure", error: detail },
        status: "Failed",
      };
    }
    if (category === "Host") {
      return {
        _tag: "Complete",
        outcome: { _tag: "Failure", category, detail },
        status: "Failed",
      };
    }
    // ExecutionFailure's storage schema also accepts Control/Failed. Do not
    // turn a malformed control record into an invented stopped outcome.
    if (outcome === "Failed") {
      return failed();
    }
    return {
      _tag: "Complete",
      outcome: { _tag: "Stopped", detail, status: outcome },
      status: outcome,
    };
  }
  if (!Cause.hasInterrupts(exit.cause)) {
    return failed();
  }
  if (!terminal.has(facts.status)) {
    return { _tag: "Pending" };
  }
  if (!facts.fenced) {
    return failed();
  }
  const status =
    facts.reason?.category === "Control" && facts.reason.outcome === "TimedOut"
      ? "TimedOut"
      : "Cancelled";
  return {
    _tag: "Complete",
    outcome: {
      _tag: "Stopped",
      detail: { stoppedBy: facts.reason?.outcome ?? "RunFailed" },
      status,
    },
    status,
  };
}

/** Controller entry is distinct from descendant task attempts (an empty child enters). */
export function normalizeWorkflowInvocation(
  state: NativeInvocation,
  facts: InvocationFacts,
  entered: boolean
): InvocationOutcome {
  if (!entered) {
    return {
      _tag: terminal.has(facts.status) ? "NoNativeExecution" : "Pending",
    };
  }
  if (Option.isSome(state) && state.value._tag === "PendingCompletion") {
    return { _tag: "Pending" };
  }
  if (Option.isSome(state) && state.value._tag === "Complete") {
    return normalizeInvocation(state, facts);
  }
  if (!terminal.has(facts.status)) {
    return { _tag: "Pending" };
  }
  if (!facts.fenced) {
    return { _tag: "Unresolved" };
  }
  // A cancelled controller may have no deferred: Effect does not cache interrupt-only exits.
  return normalizeInvocation(
    Option.some({ _tag: "Complete", exit: Exit.interrupt(0) }),
    facts
  );
}

export function outputFields(value: InvocationOutcome) {
  if (value._tag !== "Complete") {
    return {
      error: null,
      result: null,
      status:
        value._tag === "Suspended" || value._tag === "Unresolved"
          ? ("Suspended" as const)
          : ("Pending" as const),
    };
  }
  const { outcome } = value;
  switch (outcome._tag) {
    case "Succeeded": {
      return { error: null, result: outcome.value, status: value.status };
    }
    case "DomainFailure": {
      return {
        error: { category: "Domain", detail: outcome.error },
        result: null,
        status: value.status,
      };
    }
    case "Failure": {
      return {
        error:
          outcome.category === "Defect"
            ? {
                category: "Defect",
                message: "Task execution failed unexpectedly",
              }
            : { category: outcome.category, detail: outcome.detail },
        result: null,
        status: value.status,
      };
    }
    case "Stopped": {
      return {
        error: { category: "Control", detail: outcome.detail },
        result: null,
        status: value.status,
      };
    }
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

export function outcomeCategory(outcome: Outcome<Schema.Json, Schema.Json>) {
  if (outcome._tag === "DomainFailure") {
    return "Domain" as const;
  }
  if (outcome._tag === "Failure") {
    return outcome.category;
  }
  if (outcome._tag === "Stopped") {
    return "Control" as const;
  }
  return null;
}

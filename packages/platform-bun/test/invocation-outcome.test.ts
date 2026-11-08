import { expect, test } from "bun:test";

import type { Schema } from "effect";
import { Cause, Exit, Option } from "effect";

import { ExecutionFailure } from "../src/execution-boundary.ts";
import {
  normalizeInvocation,
  outputFields,
} from "../src/invocation-outcome.ts";
import type { InvocationFacts } from "../src/invocation-outcome.ts";

const complete = (exit: Exit.Exit<Schema.Json, ExecutionFailure>) =>
  Option.some({ _tag: "Complete" as const, exit });
const stopped = (
  outcome: "Cancelled" | "Rejected" | "TimedOut" | "Failed",
  category: "Control" | "Domain" = "Control"
) =>
  new ExecutionFailure({
    category,
    detail: { secretSiblingDetail: "must not copy" },
    outcome,
  });
const terminalFacts: InvocationFacts = {
  fenced: true,
  reason: stopped("Cancelled"),
  status: "Cancelled",
};

test("a cleanup defect wins over an accompanying declared error in stored outcomes", () => {
  const cause = Cause.combine(
    Cause.fail(stopped("Failed", "Domain")),
    Cause.die("cleanup failed")
  );
  expect(
    normalizeInvocation(complete(Exit.failCause(cause)), terminalFacts)
  ).toEqual({
    _tag: "Complete",
    outcome: {
      _tag: "Failure",
      category: "Defect",
      detail: { message: "Task execution failed unexpectedly" },
    },
    status: "Failed",
  });
});

test("native values and typed failures win over root fences", () => {
  expect(
    normalizeInvocation(complete(Exit.succeed("own result")), terminalFacts)
  ).toEqual({
    _tag: "Complete",
    outcome: { _tag: "Succeeded", value: "own result" },
    status: "Succeeded",
  });
  for (const category of ["Domain", "Host"] as const) {
    const detail = { _tag: "OwnError" };
    const result = normalizeInvocation(
      complete(
        Exit.fail(new ExecutionFailure({ category, detail, outcome: "Failed" }))
      ),
      terminalFacts
    );
    expect(result).toEqual({
      _tag: "Complete",
      outcome:
        category === "Domain"
          ? { _tag: "DomainFailure", error: detail }
          : { _tag: "Failure", category, detail },
      status: "Failed",
    });
  }
  const timeout = normalizeInvocation(
    complete(Exit.fail(stopped("TimedOut"))),
    terminalFacts
  );
  expect(timeout).toMatchObject({
    _tag: "Complete",
    outcome: { _tag: "Stopped", status: "TimedOut" },
    status: "TimedOut",
  });
});

test("only interrupt-only exits use terminal fence provenance", () => {
  expect(
    normalizeInvocation(complete(Exit.interrupt()), {
      ...terminalFacts,
      status: "Cancelling",
    })
  ).toEqual({ _tag: "Pending" });
  for (const reason of [
    null,
    stopped("Cancelled"),
    stopped("Rejected"),
    stopped("Failed", "Domain"),
    stopped("TimedOut"),
  ]) {
    const status = reason?.outcome === "TimedOut" ? "TimedOut" : "Cancelled";
    const result = normalizeInvocation(complete(Exit.interrupt()), {
      ...terminalFacts,
      reason,
    });
    expect(result).toEqual({
      _tag: "Complete",
      outcome: {
        _tag: "Stopped",
        detail: { stoppedBy: reason?.outcome ?? "RunFailed" },
        status,
      },
      status,
    });
  }
  expect(
    normalizeInvocation(complete(Exit.interrupt()), {
      ...terminalFacts,
      fenced: false,
      reason: null,
    })
  ).toMatchObject({
    _tag: "Complete",
    outcome: { _tag: "Failure", category: "Defect" },
    status: "Failed",
  });
  const mixed = Exit.failCause(
    Cause.combine(Cause.interrupt(), Cause.die("defect"))
  );
  expect(normalizeInvocation(complete(mixed), terminalFacts)).toMatchObject({
    outcome: { category: "Defect" },
    status: "Failed",
  });
});

test("absent and suspended native state never invent completion or eligibility", () => {
  const suspended = Option.some({ _tag: "Suspended" as const });
  expect(
    normalizeInvocation(Option.none(), { ...terminalFacts, status: "Running" })
  ).toEqual({ _tag: "Pending" });
  expect(normalizeInvocation(Option.none(), terminalFacts)).toEqual({
    _tag: "NoNativeExecution",
  });
  expect(
    normalizeInvocation(suspended, { ...terminalFacts, status: "Waiting" })
  ).toEqual({ _tag: "Suspended" });
  expect(normalizeInvocation(suspended, terminalFacts)).toEqual({
    _tag: "Unresolved",
  });
  expect(
    outputFields(normalizeInvocation(Option.none(), terminalFacts))
  ).toEqual({ error: null, result: null, status: "Pending" });
});

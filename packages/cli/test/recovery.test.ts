import { expect, test } from "bun:test";

import { Effect, Exit, Option } from "effect";

import { recoveryRequest, recoveryRetry } from "../src/recovery.ts";

const flags = {
  acknowledge: false,
  authorize: Option.none<string>(),
  cursor: Option.none<string>(),
  id: "run-1",
  limit: Option.none<number>(),
  reason: Option.none<string>(),
  requestKey: Option.none<string>(),
};
test("recovery is read-only unless both token and acknowledgment are supplied", () => {
  expect(Effect.runSync(recoveryRequest(flags))._tag).toBe("Assess");
  for (const change of [
    { acknowledge: true },
    { reason: Option.some("incident") },
    { requestKey: Option.some("key") },
    { authorize: Option.some("token") },
  ]) {
    expect(
      Exit.isFailure(
        Effect.runSyncExit(recoveryRequest({ ...flags, ...change }))
      )
    ).toBe(true);
  }
  const mutate = {
    ...flags,
    acknowledge: true,
    authorize: Option.some("token"),
  };
  expect(Effect.runSync(recoveryRequest(mutate))._tag).toBe("Authorize");
  for (const change of [
    { limit: Option.some(50) },
    { cursor: Option.some("cursor") },
  ]) {
    expect(
      Exit.isFailure(
        Effect.runSyncExit(recoveryRequest({ ...mutate, ...change }))
      )
    ).toBe(true);
  }
});
test("uncertain delivery quotes command arguments and omits arbitrary reason text", () => {
  const text = recoveryRetry({
    acknowledgeReexecution: true,
    reason: "secret reason\n`bad`",
    requestKey: "key'$(touch bad)",
    runId: "id",
    token: "rcv1.token",
  });
  expect(text).toContain("'key'\\''$(touch bad)'");
  expect(text).toContain("--acknowledge-reexecution");
  expect(text).not.toContain("secret reason");
  expect(text).toContain("Repeat the same --reason separately");
});

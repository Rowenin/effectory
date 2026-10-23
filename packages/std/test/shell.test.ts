import { expect, test } from "bun:test";

import { Shell } from "../src/shell.ts";
import { processLayer, runAction } from "./harness.ts";

const run = (input: typeof Shell.Input.Type) =>
  runAction(Shell, input, { services: processLayer });

test("a nonzero exit is recorded as data, not a failure", async () => {
  const { node, records, summary } = await run({
    args: ["-c", "echo hi; echo oops >&2; exit 3"],
    command: "sh",
  });
  expect(summary.run.status).toBe("succeeded");
  expect(node?.status).toBe("succeeded");
  expect(summary.run.result).toMatchObject({
    exitCode: 3,
    stderr: "oops\n",
    stdout: "hi\n",
  });
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    fqn: "Shell/run",
    kind: "Shell",
    scope: "adhoc",
    value: { exitCode: 3, stderr: "oops\n", stdout: "hi\n" },
  });
  const recorded = records[0]?.value as typeof Shell.Result.Type | undefined;
  expect(recorded?.durationMs).toBeGreaterThanOrEqual(0);
});

test("passes literal arguments, cwd, env, and stdin", async () => {
  const { summary } = await run({
    args: [
      "-c",
      'printf "%s|%s|%s|" "$1" "$PWD" "$GREETING"; cat',
      "sh",
      "$(nope) *",
    ],
    command: "sh",
    cwd: "/",
    env: { GREETING: "hello" },
    stdin: "from stdin",
  });
  expect(summary.run.result).toMatchObject({
    exitCode: 0,
    stdout: "$(nope) *|/|hello|from stdin",
  });
});

test("a timeout fails the node", async () => {
  const { node, records, summary } = await run({
    args: ["-c", "sleep 5"],
    command: "sh",
    timeoutMs: 200,
  });
  expect(summary.run.status).toBe("failed");
  expect(node?.status).toBe("failed");
  expect(node?.error).toEqual({
    message: "Process timed out after 200ms",
    tag: "ProcessError",
  });
  expect(records).toEqual([]);
});

test("spawn failures and output overflow fail the node", async () => {
  const missing = await run({ command: "/effectory-missing-executable" });
  expect(missing.node?.error?.tag).toBe("ProcessError");
  expect(missing.node?.error?.message).toContain("spawn");
  const overflow = await run({
    args: ["-c", "printf '%0100d' 0"],
    command: "sh",
    maxOutputBytes: 10,
  });
  expect(overflow.node?.error).toEqual({
    message: "Process output exceeded 10 bytes",
    tag: "ProcessError",
  });
});

test("tailChars records only the end of each stream", async () => {
  const { summary } = await run({
    args: ["-c", "printf 'abcdef'; printf 'uvwxyz' >&2; exit 1"],
    command: "sh",
    tailChars: 3,
  });
  expect(summary.run.result).toMatchObject({
    exitCode: 1,
    stderr: "xyz",
    stdout: "def",
  });
});

test("invalid input is refused before anything runs", async () => {
  await expect(
    run({ args: ["-c", "true"], command: "sh", timeoutMs: 0 })
  ).rejects.toMatchObject({ _tag: "RunError", reason: "invalid-input" });
});

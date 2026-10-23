// Process readiness and disappearance must be observed sequentially.
/* oxlint-disable no-await-in-loop */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect";

import * as Process from "../src/process.ts";
import { processLayer } from "./harness.ts";

const operation = (input: typeof Process.Input.Type) =>
  Process.exec(input).pipe(Effect.provide(processLayer));
const run = (input: typeof Process.Input.Type) =>
  Effect.runPromise(operation(input));
const failure = (input: typeof Process.Input.Type) =>
  Effect.runPromise(operation(input).pipe(Effect.flip));
const script = (
  source: string,
  options: Omit<typeof Process.Input.Type, "command" | "args"> = {}
) => ({
  args: ["--eval", source],
  command: process.execPath,
  ...options,
});

test("executes literal arguments and stdin with an explicit cwd and replacement environment", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "factory process "));
  const executable = path.join(directory, "bun executable");
  symlinkSync(process.execPath, executable);
  try {
    const literal = "spaces 'quotes' $(echo nope); *";
    const result = await run({
      args: [
        "--eval",
        `console.log(JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd(), env: process.env.FACTORY_PROCESS_TEST, path: process.env.PATH ?? null, stdin: await Bun.stdin.text() })); console.error('diagnostic');`,
        literal,
      ],
      command: executable,
      cwd: realpathSync(directory),
      env: { FACTORY_PROCESS_TEST: "configured" },
      extendEnv: false,
      stdin: "hello\n世界",
    });
    expect(JSON.parse(result.stdout)).toEqual({
      args: [literal],
      cwd: realpathSync(directory),
      env: "configured",
      path: null,
      stdin: "hello\n世界",
    });
    expect(result.stderr).toBe("diagnostic\n");
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("inherits the environment by default and closes absent stdin", async () => {
  const result = await run(
    script(
      "console.log(JSON.stringify({ path: process.env.PATH, input: await Bun.stdin.text() }))"
    )
  );
  expect(JSON.parse(result.stdout)).toEqual({
    input: "",
    path: process.env.PATH,
  });
});

test("drains stdout and stderr concurrently and decodes UTF-8 across writes", async () => {
  const result = await run(
    script(
      `
    process.stdout.write('a'.repeat(100_000));
    process.stderr.write('b'.repeat(100_000));
    process.stdout.write(Buffer.from([0xe4, 0xb8]));
    setTimeout(() => process.stdout.write(Buffer.from([0x96])), 10);
  `,
      { maxOutputBytes: 210_000 }
    )
  );
  expect(result.stdout).toBe(`${"a".repeat(100_000)}世`);
  expect(result.stderr).toBe("b".repeat(100_000));
});

test("nonzero exits fail with bounded diagnostics and schema-serializable errors", async () => {
  const error = await failure(
    script("console.log('partial'); console.error('bad'); process.exitCode = 7")
  );
  expect(error.message).toBe("Process exited with code 7: bad");
  expect(error.reason).toBe("non-zero-exit");
  expect(error.exitCode).toBe(7);
  expect(error.stdout).toBe("partial\n");
  expect(error.stderr).toBe("bad\n");
  const encoded = await Effect.runPromise(
    Schema.encodeEffect(Schema.toCodecJson(Process.ProcessError))(error)
  );
  expect(encoded).toMatchObject({
    _tag: "ProcessError",
    exitCode: 7,
    reason: "non-zero-exit",
  });
});

test("missing executables and invalid input fail through typed errors", async () => {
  const missingExecutable = await failure({
    command: "/factory-missing-executable",
  });
  expect(missingExecutable.reason).toBe("spawn");
  const missingDirectory = await failure(
    script("", { cwd: "/factory-missing-directory" })
  );
  expect(missingDirectory.reason).toBe("spawn");
  for (const input of [
    { command: "" },
    script("", { timeoutMs: 0 }),
    script("", { maxOutputBytes: -1 }),
    script("", { env: { "bad=name": "value" } }),
    { command: "bad\0command" },
  ]) {
    const error = await failure(input);
    expect(error.reason).toBe("invalid-input");
  }
});

test("enforces the combined stdout/stderr byte limit", async () => {
  const error = await failure(
    script(
      `
    process.stdout.write('12345');
    setTimeout(() => process.stderr.write('678901'), 30);
  `,
      { maxOutputBytes: 10 }
    )
  );
  expect(error.reason).toBe("output-limit");
  expect(
    Buffer.byteLength(error.stdout) + Buffer.byteLength(error.stderr)
  ).toBeLessThanOrEqual(10);
  const defaultError = await failure(
    script("process.stdout.write('a'.repeat(70_000))")
  );
  expect(defaultError.reason).toBe("output-limit");
});

const waitFor = async (ready: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for process fixture");
    }
    await Bun.sleep(10);
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.each(["timeout", "interrupt", "output-limit", "leader-exit"] as const)(
  "%s cleans up a SIGTERM-resistant process and its descendant",
  async (mode) => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "factory-process-cleanup-")
    );
    const childFile = path.join(directory, "child.pid");
    const parentFile = path.join(directory, "parent.pid");
    const childSource = `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(${JSON.stringify(childFile)}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
    const parentSource = `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(${JSON.stringify(parentFile)}, String(process.pid));
    require('node:child_process').spawn(process.execPath, ['--eval', ${JSON.stringify(childSource)}], { stdio: 'ignore' });
    setInterval(() => {
      if (${JSON.stringify(mode)} === 'output-limit' && require('node:fs').existsSync(${JSON.stringify(childFile)})) process.stdout.write('x'.repeat(1024));
      if (${JSON.stringify(mode)} === 'leader-exit' && require('node:fs').existsSync(${JSON.stringify(childFile)})) process.exit(0);
    }, 20);
  `;
    let pids: number[] = [];
    const fiber = Effect.runFork(
      operation(
        script(parentSource, {
          maxOutputBytes: 100,
          // Long enough for both fixtures to start under full-suite load.
          timeoutMs: mode === "timeout" ? 3000 : 15_000,
        })
      )
    );
    try {
      await waitFor(() => existsSync(childFile) && existsSync(parentFile));
      pids = [parentFile, childFile].map((file) =>
        Number(readFileSync(file, "utf-8"))
      );
      if (mode === "interrupt") {
        await Effect.runPromise(Fiber.interrupt(fiber));
        const exit = await Effect.runPromise(Fiber.await(fiber));
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
          true
        );
      } else if (mode === "leader-exit") {
        const exit = await Effect.runPromise(Fiber.await(fiber));
        expect(Exit.isSuccess(exit)).toBe(true);
      } else {
        const exit = await Effect.runPromise(Fiber.await(fiber));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain(mode);
        }
      }
      await waitFor(() => pids.every((pid) => !alive(pid)));
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      for (const file of [parentFile, childFile]) {
        if (existsSync(file)) {
          const pid = Number(readFileSync(file, "utf-8"));
          if (alive(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
      }
      rmSync(directory, { force: true, recursive: true });
    }
  },
  30_000
);

test("allowNonZeroExit returns a nonzero exit as a result", async () => {
  const result = await run(
    script(
      "console.log('partial'); console.error('bad'); process.exitCode = 7",
      {
        allowNonZeroExit: true,
      }
    )
  );
  expect(result).toMatchObject({
    exitCode: 7,
    stderr: "bad\n",
    stdout: "partial\n",
  });
});

test("layer defaults apply unless a command overrides them", async () => {
  const program = Effect.gen(function* defaultsTest() {
    const process = yield* Process.Service;
    return yield* Effect.all([
      process.exec(script("console.log(process.env.A + process.env.B)")),
      process.exec(
        script("console.log(process.env.A + process.env.B)", {
          env: { B: "2" },
        })
      ),
    ]);
  }).pipe(
    Effect.provide(
      Process.make({ env: { A: "a", B: "b" } }).pipe(
        Layer.provide(BunServices.layer)
      )
    )
  );
  const [defaults, overridden] = await Effect.runPromise(program);
  expect(defaults.stdout).toBe("ab\n");
  expect(overridden.stdout).toBe("a2\n");
});

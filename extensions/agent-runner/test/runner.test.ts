/* oxlint-disable unicorn/no-await-expression-member -- Compact sequential fixture reads. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Task } from "@offtree/effectory-sdk";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
} from "effect";

import { argumentsFor, parseOutput } from "../src/cli.ts";
import { AgentRunner, layer, makeTask, RunSession } from "../src/contracts.ts";
import extension from "../src/extension.ts";
import type { Adapter, Options, Policy } from "../src/options.ts";

let directory = "";
let executable = "";
const policy: Policy = {
  claude: {
    allowedTools: ["Read"],
    disallowedTools: ["Bash", "Edit", "Write"],
  },
  codex: { sandbox: "read-only" },
  opencode: [{ action: "allow", pattern: "*", permission: "read" }],
};
const input = (platform = "claude") => ({
  platform,
  policy: "read",
  prompt: "fix\n$(touch nope)",
  workingDirectory: directory,
});
function recordPath(kind: string, mode: string) {
  return path.join(directory, `${kind}-${mode}.jsonl`);
}
function services(
  kind: "claude" | "codex" | "opencode",
  mode = "success",
  timeoutMillis = 5000,
  payload?: Schema.Json
) {
  const options: Options = {
    platforms: {
      [kind]: {
        configuration: "fixture-v1",
        environment: Effect.succeed({
          FIXTURE_KIND: kind,
          FIXTURE_MODE: mode,
          FIXTURE_RECORD: path.join(directory, `${kind}-${mode}.jsonl`),
          ...(payload === undefined
            ? {}
            : { FIXTURE_PAYLOAD: JSON.stringify(payload) }),
        }),
        executable,
        kind,
        version: "1.0.0",
      },
    },
    policies: { read: policy },
    timeoutMillis,
  };
  return layer(options).pipe(Layer.provide(BunServices.layer));
}
async function run(
  kind: "claude" | "codex" | "opencode",
  mode = "success",
  timeout = 5000
) {
  return await Effect.runPromise(
    Task.test(extension.tasks.RunSession, { input: input(kind) }).pipe(
      Effect.provide(services(kind, mode, timeout))
    )
  );
}
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "effectory-agents-"));
  executable = path.join(directory, "agent");
  await writeFile(
    executable,
    `#!${process.execPath}\n${await readFile(path.join(import.meta.dir, "fixture.ts"), "utf-8")}`
  );
  await chmod(executable, 0o755);
});
afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

for (const kind of ["claude", "codex", "opencode"] as const) {
  test(`${kind}: common task result, usage, publication, and explicit resume`, async () => {
    const result = await run(kind);
    expect(result.value.output).toBe("done");
    expect(result.value.platform).toBe(kind);
    expect(result.value.usage?.inputTokens).toBe(3);
    expect(result.publications).toHaveLength(1);
    expect(result.value.session?.configuration).toBe("fixture-v1");
    const resumed = await Effect.runPromise(
      Task.test(extension.tasks.RunSession, {
        input: {
          ...input(kind),
          ...(result.value.session === undefined
            ? {}
            : { resume: result.value.session }),
          retainTranscript: true,
        },
      }).pipe(Effect.provide(services(kind)))
    );
    expect(resumed.publications).toHaveLength(2);
    expect(resumed.value.output).toBe("done");
  });
}
test("CLI prompts use stdin without a shell or inherited daemon environment", async () => {
  await run("claude");
  const lines = (
    await readFile(path.join(directory, "claude-success.jsonl"), "utf-8")
  )
    .trim()
    .split("\n");
  const record = Schema.decodeUnknownSync(
    Schema.Struct({
      args: Schema.Array(Schema.String),
      inheritedHome: Schema.Boolean,
      prompt: Schema.String,
    })
  )(JSON.parse(lines.at(-1) ?? "null"));
  expect(record.prompt).toBe(input().prompt);
  expect(record.args).not.toContain(input().prompt);
  expect(record.inheritedHome).toBe(false);
});
test("malformed output, capacity failures and bounded output are typed failures", async () => {
  await expect(run("claude", "malformed")).rejects.toMatchObject({
    code: "ProtocolError",
  });
  await expect(run("codex", "fail")).rejects.toMatchObject({
    code: "CapacityLimit",
  });
  await expect(run("codex", "large")).rejects.toMatchObject({
    code: "OutputLimit",
  });
});
test("zero exit without terminal success and denied permissions cannot succeed", async () => {
  await expect(
    Effect.runPromise(parseOutput("codex", '{"type":"thread.started"}\n', 0))
  ).rejects.toMatchObject({ code: "ProtocolError" });
  await expect(
    Effect.runPromise(
      parseOutput(
        "claude",
        JSON.stringify({
          permission_denials: [{}],
          result: "done",
          subtype: "success",
          type: "result",
        }),
        0
      )
    )
  ).rejects.toMatchObject({ code: "PermissionDenied" });
  await expect(
    Effect.runPromise(
      parseOutput(
        "claude",
        JSON.stringify({ result: "done", subtype: "success", type: "result" }),
        1
      )
    )
  ).rejects.toMatchObject({ code: "ExecutionFailed" });
});
test("unknown options are rejected before execution", async () => {
  await expect(
    Effect.runPromise(
      argumentsFor("claude", {
        input: { ...input(), options: { unknown: true } },
        policy,
        progress: () => Effect.void,
      })
    )
  ).rejects.toMatchObject({ code: "UnsupportedOption" });
});
test("timeout kills a CLI process group including its descendant", async () => {
  await expect(run("claude", "hang", 1000)).rejects.toMatchObject({
    code: "Timeout",
  });
  const pid = Number(
    await readFile(path.join(directory, "claude-hang.jsonl.pid"), "utf-8")
  );
  expect(() => process.kill(pid, 0)).toThrow();
});
test("OpenCode uses authenticated Distilled operations and aborts before shutdown", async () => {
  await expect(run("opencode", "hang", 1500)).rejects.toMatchObject({
    code: "Timeout",
  });
  const calls = (
    await readFile(path.join(directory, "opencode-hang.jsonl"), "utf-8")
  )
    .trim()
    .split("\n")
    .map((line) =>
      Schema.decodeUnknownSync(
        Schema.Struct({ auth: Schema.Boolean, path: Schema.String })
      )(JSON.parse(line))
    );
  expect(calls.every((call) => call.auth)).toBe(true);
  expect(calls.some((call) => call.path.endsWith("/abort"))).toBe(true);
});
test("resume identity is checked and workspace locks survive interruption", async () => {
  const started = Deferred.makeUnsafe<undefined>();
  const adapter: Adapter = {
    configuration: "custom",
    run: () =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    supportsResume: true,
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* AgentRunner;
      const first = yield* Effect.forkChild(
        runner.run(input("custom"), () => Effect.void)
      );
      yield* Deferred.await(started);
      const busy = yield* Effect.exit(
        runner.run(input("custom"), () => Effect.void)
      );
      expect(Exit.isFailure(busy) && Cause.pretty(busy.cause)).toContain(
        "already in use"
      );
      yield* Fiber.interrupt(first);
      const invalid = yield* Effect.exit(
        runner.run(
          {
            ...input("custom"),
            resume: {
              configuration: "wrong",
              platform: "custom",
              policy: "read",
              sessionId: "abc",
              workingDirectory: directory,
            },
          },
          () => Effect.void
        )
      );
      expect(Exit.isFailure(invalid) && Cause.pretty(invalid.cause)).toContain(
        "does not match"
      );
      const cancelled = yield* runner
        .run(input("custom"), () => Effect.void)
        .pipe(Effect.timeoutOption(20));
      expect(cancelled._tag).toBe("None");
    }).pipe(
      Effect.provide(
        layer({
          adapters: { custom: adapter },
          policies: { read: policy },
        }).pipe(Layer.provide(BunServices.layer))
      )
    )
  );
});
test("the task contract uses manual replay", () => {
  expect(RunSession.spec.replay).toBe("manual");
});

test("authentication diagnostics stay private and version mismatch stops execution", async () => {
  await expect(run("codex", "auth")).rejects.toMatchObject({
    code: "Authentication",
    message: "Agent process failed",
  });
  await expect(run("claude", "version-mismatch")).rejects.toMatchObject({
    code: "InvalidConfiguration",
  });
});
test("OpenCode capacity errors are typed and prompt requests are never retried", async () => {
  await expect(run("opencode", "capacity")).rejects.toMatchObject({
    code: "CapacityLimit",
  });
  const raw = await readFile(
    path.join(directory, "opencode-capacity.jsonl"),
    "utf-8"
  );
  expect(
    raw.split("\n").filter((line) => line.includes("/message"))
  ).toHaveLength(1);
});

class CredentialEnvironment extends Context.Service<
  CredentialEnvironment,
  { readonly values: Record<string, string> }
>()("agent-test/CredentialEnvironment") {}
test("credential effects retain service requirements, resolve per attempt, and sanitize failures", async () => {
  let resolutions = 0;
  const configured = layer({
    platforms: {
      claude: {
        configuration: "credentials",
        environment: Effect.map(CredentialEnvironment, (credentials) => {
          resolutions += 1;
          return credentials.values;
        }),
        executable,
        kind: "claude",
        version: "1.0.0",
      },
    },
    policies: { read: policy },
  }).pipe(
    Layer.provide(
      Layer.merge(
        BunServices.layer,
        Layer.succeed(CredentialEnvironment, {
          values: { FIXTURE_KIND: "claude" },
        })
      )
    )
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      expect(resolutions).toBe(0);
      yield* Task.test(extension.tasks.RunSession, { input: input() });
      yield* Task.test(extension.tasks.RunSession, { input: input() });
      expect(resolutions).toBe(2);
    }).pipe(Effect.provide(configured))
  );
  const failing = layer({
    platforms: {
      claude: {
        configuration: "failure",
        environment: Effect.fail("CANARY-credential-error"),
        executable,
        kind: "claude",
        version: "1.0.0",
      },
    },
    policies: { read: policy },
  }).pipe(Layer.provide(BunServices.layer));
  await expect(
    Effect.runPromise(
      Task.test(extension.tasks.RunSession, { input: input() }).pipe(
        Effect.provide(failing)
      )
    )
  ).rejects.toMatchObject({
    code: "Authentication",
    message: "Agent credentials could not be resolved",
  });
});

const Review = makeTask({
  id: "test/structured-review",
  output: Schema.Struct({ count: Schema.Int, ok: Schema.Boolean }),
  version: 1,
});
for (const kind of ["claude", "codex", "opencode"] as const) {
  test(`${kind}: structured output is requested natively, decoded, published, and resumed`, async () => {
    const first = await Effect.runPromise(
      Task.test(Review, {
        input: { ...input(kind), retainTranscript: true },
      }).pipe(Effect.provide(services(kind)))
    );
    expect(first.value.output).toEqual({ count: 2, ok: true });
    expect(first.value.usage?.inputTokens).toBe(3);
    expect(first.publications[0]?.value).toMatchObject({
      output: { count: 2, ok: true },
    });
    expect(first.publications).toHaveLength(2);
    const next = await Effect.runPromise(
      Task.test(Review, {
        input: {
          ...input(kind),
          ...(first.value.session === undefined
            ? {}
            : { resume: first.value.session }),
        },
      }).pipe(Effect.provide(services(kind)))
    );
    expect(next.value.output).toEqual(first.value.output);
    const raw = await readFile(recordPath(kind, "success"), "utf-8");
    if (kind === "opencode") {
      expect(raw).toContain('"type":"json_schema"');
      expect(raw).toContain('"retryCount":0');
    } else {
      expect(raw).toContain(
        kind === "claude" ? "--json-schema" : "--output-schema"
      );
      if (kind === "codex") {
        const record = raw
          .trim()
          .split("\n")
          .map((line) =>
            Schema.decodeUnknownSync(
              Schema.Struct({ schemaPath: Schema.optionalKey(Schema.String) })
            )(JSON.parse(line))
          )
          .findLast((row) => row.schemaPath !== undefined);
        expect(record?.schemaPath).toBeDefined();
        if (record?.schemaPath !== undefined) {
          expect(await Bun.file(record.schemaPath).exists()).toBe(false);
        }
      }
    }
  });
  for (const mode of ["missing-structured", "wrong-structured"] as const) {
    test(`${kind}: ${mode} fails schema validation without a text fallback`, async () => {
      await expect(
        Effect.runPromise(
          Task.test(Review, { input: input(kind) }).pipe(
            Effect.provide(services(kind, mode))
          )
        )
      ).rejects.toMatchObject({ code: "InvalidStructuredOutput" });
    });
  }
}
for (const kind of ["claude", "opencode"] as const) {
  test(`${kind}: native structured-output failure is sanitized`, async () => {
    await expect(
      Effect.runPromise(
        Task.test(Review, { input: input(kind) }).pipe(
          Effect.provide(services(kind, "structured-failure"))
        )
      )
    ).rejects.toMatchObject({ code: "InvalidStructuredOutput" });
  });
}
test("custom adapters explicitly opt into structured output", async () => {
  let called = false;
  const custom: Adapter = {
    configuration: "custom",
    run: () => {
      called = true;
      return Effect.succeed({
        output: "done",
        transcript: [],
        version: "fixture",
      });
    },
    supportsResume: false,
  };
  await expect(
    Effect.runPromise(
      Task.test(Review, { input: input("custom") }).pipe(
        Effect.provide(
          layer({ adapters: { custom }, policies: { read: {} } }).pipe(
            Layer.provide(BunServices.layer)
          )
        )
      )
    )
  ).rejects.toMatchObject({ code: "UnsupportedOption" });
  expect(called).toBe(false);
});

for (const kind of ["claude", "codex", "opencode"] as const) {
  test(`${kind}: arrays and falsy scalar outputs preserve their types`, async () => {
    const cases = [
      { schema: Schema.Int, value: 0 },
      { schema: Schema.Boolean, value: false },
      { schema: Schema.Null, value: null },
      { schema: Schema.String, value: "" },
      { schema: Schema.Array(Schema.String), value: ["one", "two"] },
    ];
    await Promise.all(
      cases.map(async ({ schema, value }, index) => {
        const task = makeTask({
          format: "json",
          id: `test/scalar-${index}`,
          output: schema,
          version: 1,
        });
        const result = await Effect.runPromise(
          Task.test(task, { input: input(kind) }).pipe(
            Effect.provide(services(kind, "success", 5000, value))
          )
        );
        expect(result.value.output).toEqual(value);
      })
    );
  });
}
test("Codex schema files are removed on timeout as well as success", async () => {
  await expect(
    Effect.runPromise(
      Task.test(Review, { input: input("codex") }).pipe(
        Effect.provide(services("codex", "hang", 1000))
      )
    )
  ).rejects.toMatchObject({ code: "Timeout" });
  const raw = await readFile(path.join(directory, "codex-hang.jsonl"), "utf-8");
  const record = Schema.decodeUnknownSync(
    Schema.Struct({ schemaPath: Schema.String })
  )(JSON.parse(raw.trim().split("\n").at(-1) ?? "null"));
  expect(await Bun.file(record.schemaPath).exists()).toBe(false);
});

test("Claude JSON mode accepts verbose message arrays from native settings", async () => {
  const result = await Effect.runPromise(
    Task.test(Review, { input: input("claude") }).pipe(
      Effect.provide(services("claude", "verbose-json"))
    )
  );
  expect(result.value.output).toEqual({ count: 2, ok: true });
});

/* oxlint-disable unicorn/no-await-expression-member -- Sequential fixture reads after daemon transitions. */
/* oxlint-disable no-await-in-loop -- Poll real daemon state with a bounded deadline. */
import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

import {
  cli,
  start,
} from "../../../packages/platform-bun/test/fixtures/cli.ts";

const Started = Schema.Struct({ runId: Schema.String });
const State = Schema.Struct({ status: Schema.String });
const ProcessRecord = Schema.Struct({ pid: Schema.Int });

test("daemon persists typed results and holds interrupted agent tasks for manual recovery", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-agent-daemon-")
  );
  const repository = path.join(directory, "repository");
  const record = path.join(directory, "agent.jsonl");
  const executable = path.join(directory, "agent");
  const children: Awaited<ReturnType<typeof start>>[] = [];
  let agentPid: number | undefined;
  try {
    await mkdir(repository);
    await symlink(
      path.resolve(import.meta.dir, "../../../node_modules"),
      path.join(repository, "node_modules"),
      "dir"
    );
    await writeFile(
      executable,
      `#!${process.execPath}\n${await readFile(path.join(import.meta.dir, "fixture.ts"), "utf-8")}`
    );
    await chmod(executable, 0o755);
    const source = path.resolve(import.meta.dir, "../src");
    await writeFile(
      path.join(repository, "effectory.ts"),
      `
import { Application, Extension } from "@offtree/effectory-sdk";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import extension from ${JSON.stringify(path.join(source, "extension.ts"))};
import { layer, makeTask } from ${JSON.stringify(path.join(source, "contracts.ts"))};
const Review = makeTask({ id: "fixture/review", version: 1, output: Schema.Struct({ ok: Schema.Boolean, count: Schema.Int }) });
export default Application.make({ tasks: [Review], extensions: [Extension.use(extension)] }).provide(layer({
  platforms: { "claude-json": { kind: "claude", configuration: "json", executable: ${JSON.stringify(executable)}, version: "1.0.0", environment: Effect.succeed({ FIXTURE_KIND: "claude" }) }, claude: { kind: "claude", configuration: "fixture", executable: ${JSON.stringify(executable)}, version: "1.0.0", environment: Effect.succeed({ FIXTURE_KIND: "claude", FIXTURE_MODE: "hang", FIXTURE_RECORD: ${JSON.stringify(record)} }) } },
  policies: { read: { claude: { allowedTools: ["Read"], disallowedTools: ["Bash", "Edit", "Write"] } } },
}).pipe(Layer.provide(BunServices.layer)));
`
    );
    const first = await start(repository);
    children.push(first);
    const ordinary = Schema.decodeUnknownSync(
      Schema.Struct({ result: Schema.Struct({ output: Schema.String }) })
    )(
      await cli(repository, [
        "task",
        "run",
        "offtree/agent-runner/run-session",
        "--input",
        JSON.stringify({
          platform: "claude-json",
          policy: "read",
          prompt: "plain",
          workingDirectory: repository,
        }),
      ])
    );
    expect(ordinary.result.output).toBe("done");
    const reviewed = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({
          output: Schema.Struct({ count: Schema.Int, ok: Schema.Boolean }),
        }),
        runId: Schema.String,
      })
    )(
      await cli(repository, [
        "task",
        "run",
        "fixture/review",
        "--input",
        JSON.stringify({
          platform: "claude-json",
          policy: "read",
          prompt: "review",
          workingDirectory: repository,
        }),
      ])
    );
    expect(reviewed.result.output).toEqual({ count: 2, ok: true });
    const run = Schema.decodeUnknownSync(Started)(
      await cli(repository, [
        "task",
        "run",
        "offtree/agent-runner/run-session",
        "--background",
        "--input",
        JSON.stringify({
          platform: "claude",
          policy: "read",
          prompt: "wait",
          workingDirectory: repository,
        }),
      ])
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const raw = await readFile(record, "utf-8");
        agentPid = Schema.decodeUnknownSync(ProcessRecord)(
          JSON.parse(raw.trim().split("\n")[0] ?? "null")
        ).pid;
        break;
      } catch {
        await Bun.sleep(50);
      }
    }
    expect(agentPid).toBeDefined();
    first.kill("SIGKILL");
    await first.exited;
    // SIGKILL cannot run Effect finalizers. Reap the orphaned fixture group explicitly.
    if (agentPid !== undefined) {
      process.kill(-agentPid, "SIGKILL");
      agentPid = undefined;
    }
    const restarted = await start(repository);
    children.push(restarted);
    expect(
      Schema.decodeUnknownSync(State)(
        await cli(repository, ["run", "get", reviewed.runId])
      ).status
    ).toBe("Succeeded");
    expect(
      await cli(repository, ["run", "outputs", reviewed.runId])
    ).toMatchObject({
      items: [
        {
          result: { output: { count: 2, ok: true } },
          taskId: "fixture/review",
        },
      ],
    });
    let status = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      ({ status } = Schema.decodeUnknownSync(State)(
        await cli(repository, ["run", "get", run.runId])
      ));
      if (status === "NeedsAttention") {
        break;
      }
      await Bun.sleep(50);
    }
    expect(status).toBe("NeedsAttention");
    const recovery = JSON.stringify(
      await cli(repository, ["run", "recover", run.runId])
    );
    expect(recovery).toContain("offtree/agent-runner/run-session");
    expect(recovery).toContain("uncertain");
    const lines = (await readFile(record, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(1);
  } finally {
    if (agentPid !== undefined) {
      try {
        process.kill(-agentPid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

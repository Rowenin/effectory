/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Sequential CLI mutations and bounded daemon readiness are intentional. */
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Schema } from "effect";

import { effectory, start } from "./fixtures/cli.ts";

const decodeJsonObject = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
);

test("vault CLI, two providers, guards, kill/restart, and offline escrow", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "effectory-vault-cli-"));
  let repository = path.join(base, "repo");
  await mkdir(repository);
  const environment = {
    ...process.env,
    EFFECTORY_KEY_DIR: path.join(base, "keys"),
  };
  const children: Awaited<ReturnType<typeof start>>[] = [];
  const invoke = async (args: string[], json = true) => {
    const child = Bun.spawn(
      [
        ...effectory,
        ...args,
        "--repository",
        repository,
        ...(json ? ["--json"] : []),
      ],
      { env: environment, stderr: "pipe", stdout: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      code,
      stderr,
      stdout,
      value: json && stdout.trim() ? decodeJsonObject(stdout) : undefined,
    };
  };
  try {
    await writeFile(
      path.join(repository, "effectory.ts"),
      await readFile(
        path.resolve(import.meta.dir, "../../../examples/vaults/effectory.ts")
      )
    );
    const first = await start(repository, environment);
    children.push(first);
    expect(
      (await invoke(["vault", "describe", "infrastructure"])).value?.state
    ).toBe("NotInitialized");
    expect((await invoke(["vault", "init", "infrastructure"])).code).toBe(0);
    const token = "CANARY-daemon-vault-token-12345678";
    const input = path.join(base, "input.txt");
    await writeFile(input, token);
    const put = [
      "vault",
      "put",
      "infrastructure",
      "database-password",
      "--file",
      input,
      "--if-version",
      "0",
      "--request-key",
      "initial",
    ];
    const inserted = await invoke(put);
    expect(inserted.code).toBe(0);
    expect(inserted.value?.version).toBe("1");
    const safe = await invoke([
      "task",
      "run",
      "vault/read",
      "--input",
      '"safe"',
    ]);
    expect(safe.code).toBe(0);
    expect(safe.value?.result).toBe("Read both providers");
    for (const mode of [
      "result",
      "error",
      "host",
      "artifact",
      "metadata",
      "defect",
    ]) {
      const result = await invoke([
        "task",
        "run",
        "vault/read",
        "--input",
        JSON.stringify(mode),
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain(token);
      expect(result.stdout + result.stderr).not.toContain(
        "example-fixture-github-token"
      );
    }
    const logs = await invoke(["run", "logs", String(safe.value?.runId)]);
    expect(logs.stdout).toContain("vault secret omitted");
    expect(logs.stdout).not.toContain(token);
    first.kill("SIGKILL");
    await first.exited;
    children.push(await start(repository, environment));
    expect((await invoke(put)).value?.replayed).toBe(true);
    const reveal = await invoke(
      ["vault", "reveal", "infrastructure", "database-password"],
      false
    );
    expect(reveal.code).toBe(0);
    expect(reveal.stdout).toBe(token);
    const remotePut = await invoke([
      "vault",
      "put",
      "integrations",
      "github-token",
      "--file",
      input,
      "--if-version",
      "0",
    ]);
    expect(remotePut.code).toBe(2);
    expect(remotePut.stderr).toContain("read-only");
    expect((await invoke(["daemon", "stop"])).code).toBe(0);
    await children.at(-1)?.exited;
    const recovery = path.join(base, "recovery.json");
    expect(
      (
        await invoke([
          "vault",
          "key",
          "export",
          "infrastructure",
          "--output",
          recovery,
        ])
      ).code
    ).toBe(0);
    const snapshot = path.join(base, "snapshot");
    expect((await invoke(["backup", snapshot])).code).toBe(0);
    const original = repository;
    repository = path.join(base, "restored");
    expect((await invoke(["restore", snapshot])).code).toBe(0);
    await rm(original, { recursive: true });
    await rm(environment.EFFECTORY_KEY_DIR, { recursive: true });
    children.push(await start(repository, environment));
    expect(
      (await invoke(["vault", "describe", "infrastructure"])).value?.state
    ).toBe("KeyMissing");
    expect((await invoke(["daemon", "stop"])).code).toBe(0);
    await children.at(-1)?.exited;
    expect(
      (
        await invoke([
          "vault",
          "key",
          "import",
          "infrastructure",
          "--file",
          recovery,
        ])
      ).code
    ).toBe(0);
    children.push(await start(repository, environment));
    const restoredReveal = await invoke(
      ["vault", "reveal", "infrastructure", "database-password"],
      false
    );
    expect(restoredReveal.code).toBe(0);
    expect(restoredReveal.stdout).toBe(token);
    expect((await invoke(put)).value?.replayed).toBe(true);
    expect((await invoke(["daemon", "stop"])).code).toBe(0);
    await children.at(-1)?.exited;
    expect(
      (await invoke(["vault", "reset", "infrastructure", "--discard"])).code
    ).toBe(0);
    children.push(await start(repository, environment));
    expect(
      (await invoke(["vault", "describe", "infrastructure"])).value?.state
    ).toBe("NotInitialized");
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
    await rm(base, { force: true, recursive: true });
  }
}, 120_000);

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Run, Wait, WaitReceipt } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { Endpoint } from "../src/daemon.ts";
import { approval, cli, effectory, start } from "./fixtures/cli.ts";

async function invoke(repository: string, args: string[], stdin?: string) {
  const child = Bun.spawn(
    [...effectory, ...args, "--repository", repository, "--json"],
    {
      stderr: "pipe",
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
    }
  );
  return await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
}

test("CLI bounds file/stdin input and recovers the original receipt after a committed approval loses its reply", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "effectory-delivery-"));
  let daemon: Awaited<ReturnType<typeof start>> | undefined;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  try {
    const source = await readFile(
      path.resolve(import.meta.dir, "../../../examples/greeting/effectory.ts"),
      "utf-8"
    );
    await writeFile(path.join(repository, "effectory.ts"), source);
    daemon = await start(repository);
    const [submitted, , submitCode] = await invoke(
      repository,
      [
        "workflow",
        "run",
        "example/welcome",
        "--input-file",
        "-",
        "--background",
      ],
      '{"name":"Ada"}'
    );
    expect(submitCode).toBe(0);
    const run = Schema.decodeUnknownSync(Run)(JSON.parse(submitted));
    const wait = await approval(repository, run.runId);
    const oversized = path.join(repository, "oversized.json");
    await writeFile(oversized, `"${"x".repeat(1_048_576)}"`);
    for (const args of [
      ["--input-file", oversized],
      ["--input", "{}", "--input-file", oversized],
      ["--input", `${"[".repeat(65)}0${"]".repeat(65)}`],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Each independent CLI exits before its next bounded boundary check.
      const [, stderr, code] = await invoke(repository, [
        "workflow",
        "run",
        "example/welcome",
        "--background",
        ...args,
      ]);
      expect(code).toBe(2);
      expect(stderr).toContain("Expected JSON input");
    }
    const endpointPath = path.join(repository, ".effectory/daemon.json");
    const endpointText = await readFile(endpointPath, "utf-8");
    const endpoint = Schema.decodeUnknownSync(Endpoint)(
      JSON.parse(endpointText)
    );
    let lostReplies = 0;
    proxy = Bun.serve({
      async fetch(request) {
        const body = await request.text();
        const response = await fetch(endpoint.url, {
          body,
          headers: request.headers,
          method: request.method,
        });
        if (body.includes('"WaitApprove"')) {
          await response.text();
          lostReplies += 1;
          return new Response("lost response", {
            headers: { "content-type": "application/json" },
          });
        }
        return response;
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    await writeFile(
      endpointPath,
      JSON.stringify({ ...endpoint, url: `http://127.0.0.1:${proxy.port}/rpc` })
    );
    const [, stderr, code] = await invoke(repository, [
      "run",
      "approve",
      wait.waitId,
    ]);
    expect(code).toBe(3);
    expect(lostReplies).toBe(1);
    expect(stderr).toContain(
      `Delivery uncertain. Retry run approve ${wait.waitId}`
    );
    const key = /--request-key (?<key>[a-f\d-]{36})/u.exec(stderr)?.groups?.key;
    expect(key).toBeDefined();
    if (key === undefined) {
      throw new Error("Missing retry key");
    }
    await writeFile(endpointPath, endpointText);
    expect(
      Schema.decodeUnknownSync(Wait)(
        await cli(repository, ["run", "wait", wait.waitId])
      ).status
    ).toBe("Approved");
    const receipt = Schema.decodeUnknownSync(WaitReceipt)(
      await cli(repository, [
        "run",
        "approve",
        wait.waitId,
        "--request-key",
        key,
      ])
    );
    expect(receipt.requestKey).toBe(key);
    expect(receipt.outcome).toBe("Approved");
    expect(
      Schema.decodeUnknownSync(WaitReceipt)(
        await cli(repository, [
          "run",
          "approve",
          wait.waitId,
          "--request-key",
          key,
        ])
      )
    ).toEqual(receipt);
  } finally {
    await proxy?.stop(true);
    if (daemon?.exitCode === null) {
      daemon.kill("SIGKILL");
    }
    await daemon?.exited;
    await rm(repository, { force: true, recursive: true });
  }
}, 45_000);

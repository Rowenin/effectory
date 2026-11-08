/* oxlint-disable no-await-in-loop */
// Readiness and recovery polling depend on prior observations and have finite bounds.
import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Run } from "@effectory/runtime/protocol";
import { ServerStatus } from "@effectory/runtime/rpc";
import {
  DiagnosticReport,
  DrainReceipt,
} from "@effectory/runtime/system-protocol";
import { Schema } from "effect";

import { cli, start } from "./fixtures/cli.ts";

test("bounded drain survives uncooperative cleanup and an old receipt cannot drain its replacement", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "effectory-drain-"));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const attempts = path.join(repository, "attempts.txt");
    await writeFile(
      path.join(repository, "effectory.ts"),
      `
import { appendFileSync } from "node:fs";
import { Application, Task } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";
const hold = Task.make({ id: "hold", version: 1, input: Schema.Null, success: Schema.Null, error: Schema.Never, replay: "manual" }, () =>
  Effect.acquireUseRelease(
    Effect.sync(() => appendFileSync(${JSON.stringify(attempts)}, "started\\n")),
    () => Effect.never,
    () => Effect.never
  ));
export default Application.make({ tasks: [hold] });
`
    );
    const first = await start(repository);
    children.push(first);
    const status = Schema.decodeUnknownSync(ServerStatus)(
      await cli(repository, ["daemon", "status"])
    );
    expect(status.readiness).toBe("Ready");
    expect(status.capabilities).toContain("system.doctor.v1");
    const credentials = path.join(repository, ".effectory/credentials.json");
    await chmod(credentials, 0o644);
    const report = Schema.decodeUnknownSync(DiagnosticReport)(
      await cli(repository, ["doctor"])
    );
    expect(report.healthy).toBe(false);
    expect(
      report.findings.some(
        (finding) => finding.code === "CredentialPermissions"
      )
    ).toBe(true);
    const credentialStat = await stat(credentials);
    expect(credentialStat.mode % 512).toBe(0o644);
    await chmod(credentials, 0o600);
    const run = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "task",
        "run",
        "hold",
        "--input",
        "null",
        "--background",
      ])
    );
    let started = false;
    for (let count = 0; count < 100; count += 1) {
      started = await readFile(attempts, "utf-8")
        .then((text) => text === "started\n")
        .catch(() => false);
      if (started) {
        break;
      }
      await Bun.sleep(50);
    }
    expect(started).toBe(true);
    const before = Date.now();
    const receipt = Schema.decodeUnknownSync(DrainReceipt)(
      await cli(repository, [
        "daemon",
        "stop",
        "--grace-period-ms",
        "0",
        "--request-key",
        "stop",
      ])
    );
    expect(Date.now() - before).toBeLessThan(6000);
    expect(first.exitCode).not.toBeNull();
    children.push(await start(repository));
    expect(
      Schema.decodeUnknownSync(DrainReceipt)(
        await cli(repository, [
          "daemon",
          "stop",
          "--instance-id",
          status.instanceId,
          "--grace-period-ms",
          "0",
          "--request-key",
          "stop",
        ])
      )
    ).toEqual(receipt);
    const replacement = Schema.decodeUnknownSync(ServerStatus)(
      await cli(repository, ["daemon", "status"])
    );
    expect(replacement.instanceId).not.toBe(status.instanceId);
    expect(replacement.readiness).toBe("Ready");
    let recovered = false;
    for (let count = 0; count < 100; count += 1) {
      const observed = Schema.decodeUnknownSync(Run)(
        await cli(repository, ["run", "get", run.runId])
      );
      if (observed.status === "NeedsAttention") {
        recovered = true;
        break;
      }
      await Bun.sleep(50);
    }
    expect(recovered).toBe(true);
    expect(await readFile(attempts, "utf-8")).toBe("started\n");
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
      })
    );
    await rm(repository, { force: true, recursive: true });
  }
}, 45_000);

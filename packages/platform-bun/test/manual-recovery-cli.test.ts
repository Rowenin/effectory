import { Database } from "bun:sqlite";
/* oxlint-disable no-await-in-loop -- Bounded polling follows successive daemon state transitions. */
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Run } from "@effectory/runtime/protocol";
import {
  RecoveryAssessment,
  RecoveryReceipt,
} from "@effectory/runtime/recovery-protocol";
import { Effect, Schema } from "effect";

import { createStore } from "../src/host-store.ts";
import { cli, start, effectory } from "./fixtures/cli.ts";

test("CLI assesses without mutation and recovers the pinned run through real RPC", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-recovery-cli-")
  );
  const marker = path.join(repository, "handler-started");
  const finish = path.join(repository, "allow-finish");
  const source = `import {Application,Task} from '@offtree/effectory-sdk';
import {Effect,Schema} from 'effect';
const work=Task.make({id:'work',version:1,input:Schema.Null,success:Schema.Int,error:Schema.Never,replay:'manual'},()=>Effect.gen(function*(){
  yield* Effect.promise(()=>Bun.write(${JSON.stringify(marker)},'started'));
  if (!(yield* Effect.promise(()=>Bun.file(${JSON.stringify(finish)}).exists()))) return yield* Effect.never;
  return 42;
}));
export default Application.make({tasks:[work]});`;
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  try {
    await writeFile(path.join(repository, "effectory.ts"), source);
    const first = await start(repository);
    processes.push(first);
    const run = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "task",
        "run",
        "work",
        "--input",
        "null",
        "--background",
        "--request-key",
        "original",
      ])
    );
    for (let i = 0; i < 100 && !(await Bun.file(marker).exists()); i += 1) {
      await Bun.sleep(25);
    }
    expect(await Bun.file(marker).exists()).toBe(true);
    first.kill("SIGKILL");
    await first.exited;
    const second = await start(repository);
    processes.push(second);
    let assessment = Schema.decodeUnknownSync(RecoveryAssessment)(
      await cli(repository, ["run", "recover", run.runId])
    );
    for (let i = 0; i < 100 && assessment.state !== "Recoverable"; i += 1) {
      await Bun.sleep(25);
      assessment = Schema.decodeUnknownSync(RecoveryAssessment)(
        await cli(repository, ["run", "recover", run.runId])
      );
    }
    expect(assessment.state).toBe("Recoverable");
    if (assessment.token === null) {
      throw new Error("No token");
    }
    expect(
      Schema.decodeUnknownSync(Run)(
        await cli(repository, ["run", "get", run.runId])
      ).status
    ).toBe("NeedsAttention");
    const invalid = Bun.spawn(
      [
        ...effectory,
        "run",
        "recover",
        run.runId,
        "--authorize",
        assessment.token,
        "--repository",
        repository,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    await Promise.all([
      new Response(invalid.stdout).text(),
      new Response(invalid.stderr).text(),
    ]);
    expect(await invalid.exited).toBe(2);
    await writeFile(finish, "yes");
    const previousBinary = process.env.EFFECTORY_RECOVERY_PREVIOUS_BINARY;
    if (previousBinary !== undefined && previousBinary !== "") {
      second.kill("SIGKILL");
      await second.exited;
      const db = new Database(path.join(repository, ".effectory/state.sqlite"));
      const snapshot = () =>
        db
          .query(
            "SELECT state,authorizationId,entry FROM host_recovery_holds ORDER BY id"
          )
          .all();
      try {
        const offline = createStore(db, {
          assertActive: () => {},
          token: "offline-proof",
        });
        Effect.runSync(
          offline.recover(
            {
              acknowledgeReexecution: true,
              requestKey: "recover",
              runId: run.runId,
              token: assessment.token,
            },
            "owner"
          )
        );
        const before = snapshot();
        const incompatible = Bun.spawn(
          [previousBinary, "daemon", "serve", "--repository", repository],
          { stderr: "pipe", stdout: "pipe" }
        );
        const [code, , stderr] = await Promise.all([
          incompatible.exited,
          new Response(incompatible.stdout).text(),
          new Response(incompatible.stderr).text(),
        ]);
        expect(code).not.toBe(0);
        expect(stderr.toLowerCase()).toContain("revision");
        expect(snapshot()).toEqual(before);
      } finally {
        db.close();
      }
      processes.push(await start(repository));
    }
    const command = [
      "run",
      "recover",
      run.runId,
      "--authorize",
      assessment.token,
      "--acknowledge-reexecution",
      "--request-key",
      "recover",
    ];
    const receipt = Schema.decodeUnknownSync(RecoveryReceipt)(
      await cli(repository, command)
    );
    expect(receipt.outcome).toBe("Accepted");
    let result = Schema.decodeUnknownSync(Run)(
      await cli(repository, ["run", "get", run.runId])
    );
    for (let i = 0; i < 100 && result.status !== "Succeeded"; i += 1) {
      await Bun.sleep(25);
      result = Schema.decodeUnknownSync(Run)(
        await cli(repository, ["run", "get", run.runId])
      );
    }
    expect(result.status).toBe("Succeeded");
    expect(result.result).toBe(42);
    expect(
      Schema.decodeUnknownSync(RecoveryReceipt)(await cli(repository, command))
    ).toEqual(receipt);
  } finally {
    for (const process of processes) {
      if (process.exitCode === null) {
        process.kill("SIGKILL");
      }
    }
    await Promise.all(processes.map(async (process) => await process.exited));
    await rm(repository, { force: true, recursive: true });
  }
}, 90_000);

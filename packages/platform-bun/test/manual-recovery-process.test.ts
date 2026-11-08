/* oxlint-disable no-await-in-loop -- Each phase depends on durable state from the previous process. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

const Reply = Schema.Struct({
  outcome: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Json),
  state: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
});

const kill = async (child: ReturnType<typeof Bun.spawn>) => {
  child.kill("SIGKILL");
  await child.exited;
};

test("real interpreter recovery survives repeated kills and a durable acceptance without dispatch", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-recover-process-")
  );
  const filename = path.join(directory, "state.sqlite");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const start = async (mode: string, index: number) => {
    const ready = path.join(directory, `ready-${index}`);
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "fixtures/manual-recovery-process.ts"),
        filename,
        mode,
        ready,
      ],
      { stderr: "pipe", stdout: "ignore" }
    );
    children.push(child);
    const stderr = new Response(child.stderr).text();
    for (let i = 0; i < 1000; i += 1) {
      if (await Bun.file(ready).exists()) {
        const reply = Schema.decodeUnknownSync(Reply)(
          await Bun.file(ready).json()
        );
        return { child, reply, stderr };
      }
      if (child.exitCode !== null) {
        throw new Error(
          `Fixture ${mode} exited ${child.exitCode}: ${await stderr}`
        );
      }
      await Bun.sleep(20);
    }
    child.kill("SIGKILL");
    await child.exited;
    throw new Error(`Fixture ${mode} timed out: ${await stderr}`);
  };
  const count = (name: string) => {
    const audit = new Database(`${filename}.audit`, { readonly: true });
    try {
      return (
        audit
          .query<{ count: number }, [string]>(
            "SELECT count FROM actions WHERE name=?"
          )
          .get(name)?.count ?? 0
      );
    } finally {
      audit.close();
    }
  };
  try {
    const first = await start("start", 0);
    expect(first.reply.status).toBe("Action");
    await kill(first.child);
    // The old task-timeout window expires while no host is running.
    await Bun.sleep(1100);
    for (let index = 1; index <= 2; index += 1) {
      const held = await start("hold", index);
      expect(held.reply.state).toBe("Recoverable");
      expect(count("charge")).toBe(1);
      await kill(held.child);
    }
    const accepted = await start("accept", 3);
    expect(accepted.reply.outcome).toBe("Accepted");
    expect(await accepted.child.exited).toBe(0);
    expect(count("charge")).toBe(1);
    const resumed = await start("resume", 4);
    expect(resumed.reply.status).toBe("Action");
    expect(count("charge")).toBe(2);
    await kill(resumed.child);
    const heldAgain = await start("hold", 5);
    expect(heldAgain.reply.state).toBe("Recoverable");
    expect(count("charge")).toBe(2);
    await kill(heldAgain.child);
    const finished = await start("complete", 6);
    expect(finished.reply.status).toBe("Succeeded");
    expect(finished.reply.result).toBe(2);
    expect(await finished.child.exited).toBe(0);
    expect(count("first")).toBe(1);
    expect(count("charge")).toBe(3);
    expect(count("acquire")).toBe(3);
    expect(count("release")).toBe(1);
    const db = new Database(filename, { readonly: true });
    try {
      expect(
        db
          .query(
            "SELECT COUNT(*) count FROM host_recovery_holds WHERE state='Consumed'"
          )
          .get()
      ).toEqual({ count: 2 });
      expect(db.query("SELECT COUNT(*) count FROM lake_records").get()).toEqual(
        { count: 1 }
      );
    } finally {
      db.close();
    }
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
    await Promise.all(children.map((child) => child.exited));
    await rm(directory, { force: true, recursive: true });
  }
}, 90_000);

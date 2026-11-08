/* oxlint-disable no-await-in-loop */
// Poll readiness with a bounded deadline; every read depends on the previous one.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

const Status = Schema.Struct({
  artifacts: Schema.optionalKey(
    Schema.Array(Schema.Struct({ version: Schema.Int }))
  ),
  result: Schema.optionalKey(Schema.Json),
  runId: Schema.String,
  status: Schema.String,
  waits: Schema.optionalKey(Schema.Array(Schema.String)),
});

async function ready(filename: string, child: ReturnType<typeof Bun.spawn>) {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (await Bun.file(filename).exists()) {
      return Schema.decodeUnknownSync(Status)(await Bun.file(filename).json());
    }
    if (child.exitCode !== null) {
      throw new Error(
        typeof child.stderr === "object"
          ? await new Response(child.stderr).text()
          : "Child exited before readiness"
      );
    }
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for authored runtime");
}

test("authored graph resumes approval and reuses publication after death before task completion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-runtime-"));
  const script = path.join(import.meta.dir, "fixtures/runtime-process.ts");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = (mode: string) => {
    const filename = path.join(directory, `${mode}.json`);
    const child = Bun.spawn(
      [process.execPath, script, directory, mode, filename],
      { stderr: "pipe", stdout: "pipe" }
    );
    children.push(child);
    return { child, filename };
  };
  try {
    const first = spawn("start");
    const waiting = await ready(first.filename, first.child);
    expect(waiting.status).toBe("Waiting");
    first.child.kill("SIGKILL");
    await first.child.exited;
    const second = spawn("publish-crash");
    const published = await ready(second.filename, second.child);
    expect(published.runId).toBe(waiting.runId);
    expect(published.status).toBe("Published");
    second.child.kill("SIGKILL");
    await second.child.exited;
    const third = spawn("finish");
    const finished = await ready(third.filename, third.child);
    expect(finished.runId).toBe(waiting.runId);
    expect(finished.status).toBe("Succeeded");
    expect(finished.artifacts).toEqual([{ version: 1 }]);
    expect(await third.child.exited).toBe(0);
    const audit = new Database(path.join(directory, "audit.sqlite"));
    try {
      expect(
        audit.query("SELECT count FROM calls WHERE id = 'greet'").get()
      ).toEqual({ count: 1 });
    } finally {
      audit.close();
    }
  } finally {
    for (const child of children) {
      child.kill();
    }
    await Promise.all(children.map(async (child) => await child.exited));
    await rm(directory, { force: true, recursive: true });
  }
}, 40_000);

test.each(["workflow", "attempt", "completed"] as const)(
  "%s deadline recovery preserves elapsed time and recorded results",
  async (variant) => {
    const directory = await mkdtemp(path.join(tmpdir(), "effectory-deadline-"));
    const script = path.join(import.meta.dir, "fixtures/deadline-process.ts");
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const spawn = (phase: string) => {
      const filename = path.join(directory, `${phase}.json`);
      const child = Bun.spawn(
        [process.execPath, script, directory, `${variant}-${phase}`, filename],
        { stderr: "pipe", stdout: "pipe" }
      );
      children.push(child);
      return { child, filename };
    };
    try {
      const first = spawn("start");
      const waiting = await ready(first.filename, first.child);
      const started = Schema.decodeUnknownSync(
        Schema.Struct({ deadline: Schema.Finite })
      )(waiting.result);
      first.child.kill("SIGKILL");
      await first.child.exited;
      await Bun.sleep(Math.max(1, started.deadline - Date.now() + 100));
      const second = spawn("finish");
      const finished = await ready(second.filename, second.child);
      expect(finished.runId).toBe(waiting.runId);
      expect(finished.result).toEqual(waiting.result);
      expect(finished.waits).toEqual(waiting.waits);
      expect(finished.status).toBe(
        variant === "completed" ? "Succeeded" : "TimedOut"
      );
      expect(await second.child.exited).toBe(0);
      const audit = new Database(path.join(directory, "audit.sqlite"));
      try {
        expect(
          audit.query("SELECT COUNT(*) AS calls FROM calls").get()
        ).toEqual({ calls: variant === "workflow" ? 0 : 1 });
      } finally {
        audit.close();
      }
    } finally {
      for (const child of children) {
        child.kill();
      }
      await Promise.all(children.map(async (child) => await child.exited));
      await rm(directory, { force: true, recursive: true });
    }
  },
  40_000
);

test("fan-out retains keyed receivers, completed manual tasks and input result order across death", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-fanout-"));
  const script = path.join(import.meta.dir, "fixtures/fanout-process.ts");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = (mode: string) => {
    const filename = path.join(directory, `${mode}.json`);
    const child = Bun.spawn(
      [process.execPath, script, directory, mode, filename],
      { stderr: "pipe", stdout: "pipe" }
    );
    children.push(child);
    return { child, filename };
  };
  try {
    const first = spawn("start");
    const waiting = await ready(first.filename, first.child);
    expect(waiting.waits?.length).toBe(3);
    first.child.kill("SIGKILL");
    await first.child.exited;
    const second = spawn("finish");
    const finished = await ready(second.filename, second.child);
    expect(finished.runId).toBe(waiting.runId);
    expect(finished.waits).toEqual(waiting.waits);
    expect(finished.result).toEqual(["B", "A", "C"]);
    expect(await second.child.exited).toBe(0);
    const audit = new Database(path.join(directory, "audit.sqlite"));
    try {
      expect(
        audit.query("SELECT id, count FROM calls ORDER BY id").all()
      ).toEqual([
        { count: 1, id: "a" },
        { count: 1, id: "b" },
        { count: 1, id: "c" },
      ]);
    } finally {
      audit.close();
    }
  } finally {
    for (const child of children) {
      child.kill();
    }
    await Promise.all(children.map(async (child) => await child.exited));
    await rm(directory, { force: true, recursive: true });
  }
}, 40_000);

test("a persisted retry resumes after offline backoff without repeating the failed attempt", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-retry-"));
  const script = path.join(import.meta.dir, "fixtures/retry-process.ts");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = (mode: string) => {
    const filename = path.join(directory, `${mode}.json`);
    const child = Bun.spawn(
      [process.execPath, script, directory, mode, filename],
      { stderr: "pipe", stdout: "pipe" }
    );
    children.push(child);
    return { child, filename };
  };
  try {
    const first = spawn("start");
    const waiting = await ready(first.filename, first.child);
    const retry = Schema.decodeUnknownSync(
      Schema.Struct({ deadline: Schema.Finite })
    )(waiting.result);
    first.child.kill("SIGKILL");
    await first.child.exited;
    await Bun.sleep(Math.max(1, retry.deadline - Date.now() + 100));
    const second = spawn("finish");
    const finished = await ready(second.filename, second.child);
    expect(finished.runId).toBe(waiting.runId);
    expect(finished.result).toEqual(waiting.result);
    expect(finished.status).toBe("Succeeded");
    expect(await second.child.exited).toBe(0);
    const audit = new Database(path.join(directory, "audit.sqlite"));
    try {
      expect(
        audit
          .query(
            "SELECT attempt, COUNT(*) AS calls FROM calls GROUP BY attempt ORDER BY attempt"
          )
          .all()
      ).toEqual([
        { attempt: 1, calls: 1 },
        { attempt: 2, calls: 1 },
      ]);
      expect(
        audit.query("SELECT COUNT(DISTINCT key) AS keys FROM calls").get()
      ).toEqual({ keys: 1 });
    } finally {
      audit.close();
    }
  } finally {
    for (const child of children) {
      child.kill();
    }
    await Promise.all(children.map(async (child) => await child.exited));
    await rm(directory, { force: true, recursive: true });
  }
}, 40_000);

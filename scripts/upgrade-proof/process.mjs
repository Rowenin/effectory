/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Sequential executable proof and bounded polling. */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";

export const old = process.env.EFFECTORY_PREVIOUS_BINARY;
export const target = process.env.EFFECTORY_UPGRADE_BINARY;
const DaemonFile = Schema.Struct({ pid: Schema.optionalKey(Schema.Unknown) });

/**
 * Polls `read` until `check` accepts its value.
 * @template T
 * @param {string} label Failure message prefix.
 * @param {() => T | Promise<T>} read Reads the current value.
 * @param {(value: T) => boolean} check Accepts the value to return.
 * @param {number} [timeout] Milliseconds before the poll fails.
 * @returns {Promise<T>} The first accepted value.
 */
const until = async (label, read, check, timeout = 120_000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await read();
    if (check(v)) {
      return v;
    }
    assert.ok(Date.now() < end, `${label}: ${JSON.stringify(v)}`);
    await Bun.sleep(100);
  }
};

/**
 * Spawns CLI and daemon processes that share the proof's key directory.
 * @param {string} root Proof root holding keys and daemon logs.
 */
export function harness(root) {
  /** @type {Bun.Subprocess[]} */
  const children = [];
  const env = { ...process.env, EFFECTORY_KEY_DIR: path.join(root, "keys") };
  /** @type {(binary: string, repo: string, args: string[], timeout?: number) => Promise<{ code: number, err: string, out: string }>} */
  const raw = async (binary, repo, args, timeout = 120_000) => {
    const child = Bun.spawn([binary, ...args, "--repository", repo, "--json"], {
      cwd: repo,
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    children.push(child);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    try {
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(child.signalCode, null, `timeout ${args.join(",")}: ${err}`);
      return { code, err, out };
    } finally {
      clearTimeout(timer);
    }
  };
  /** @type {(binary: string, repo: string, args: string[]) => Promise<unknown>} */
  const cli = async (binary, repo, args) => {
    const r = await raw(binary, repo, args);
    assert.equal(r.code, 0, `${args.join(",")}: ${r.err}`);
    /** @type {unknown} */
    const output = r.out.trim() ? JSON.parse(r.out) : null;
    return output;
  };
  /** @type {(binary: string, repo: string) => Promise<Bun.Subprocess>} */
  const start = async (binary, repo) => {
    const child = Bun.spawn([binary, "daemon", "serve", "--repository", repo], {
      cwd: repo,
      env,
      stderr: Bun.file(path.join(root, `daemon-${children.length}.log`)),
      stdout: "ignore",
    });
    children.push(child);
    const limit = Date.now() + 30_000;
    for (;;) {
      assert.equal(child.exitCode, null, "daemon exited");
      assert.ok(Date.now() < limit, "daemon start timeout");
      const file = path.join(repo, ".effectory/daemon.json");
      if (existsSync(file)) {
        /** @type {unknown} */
        const data = JSON.parse(readFileSync(file, "utf-8"));
        Schema.asserts(DaemonFile, data);
        if (data.pid === child.pid) {
          break;
        }
      }
      await Bun.sleep(30);
    }
    return child;
  };
  const close = async () => {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
  };
  return { cli, close, raw, start, until };
}

/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Sequential executable proof and bounded polling. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";

import { harness, old, target } from "./process.mjs";

const LifecycleResults = Schema.Struct({
  root: Schema.String,
  targetBuild: Schema.optionalKey(Schema.Unknown),
});
const TaskResult = Schema.Struct({
  result: Schema.optionalKey(Schema.Unknown),
});

/** @type {unknown} */
const lifecycle = JSON.parse(
  readFileSync(
    path.join(
      process.env.EFFECTORY_UPGRADE_PROOF_DIR,
      "lifecycle-results.json"
    ),
    "utf-8"
  )
);
Schema.asserts(LifecycleResults, lifecycle);
const { root } = lifecycle;
const repo = path.join(root, "source");
const h = harness(root);
const snapshot = () => {
  /** @type {Record<string, string>} */
  const r = {};
  /** @type {(p: string) => void} */
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (e.name.startsWith("state.sqlite.owner") || e.name.endsWith("-shm")) {
        continue;
      }
      const f = path.join(p, e.name);
      if (e.isDirectory()) {
        r[f] = "directory";
        walk(f);
      } else {
        r[f] = createHash("sha256").update(readFileSync(f)).digest("hex");
      }
    }
  };
  walk(repo);
  return r;
};
try {
  const keyFile = path.join(root, "escrow.json");
  await h.cli(target, repo, [
    "vault",
    "key",
    "export",
    "credentials",
    "--output",
    keyFile,
  ]);
  renameSync(path.join(root, "keys"), path.join(root, "keys-hidden"));
  const results = [];
  for (const args of [
    ["daemon", "serve"],
    ["run", "reclaim", "plan", "--completed-before", "2027-01-01T00:00:00Z"],
    ["run", "reclaim", "inspect", crypto.randomUUID()],
    ["vault", "reset", "credentials", "--discard"],
    ["vault", "key", "import", "credentials", "--file", keyFile],
    ["extension", "restore"],
  ]) {
    const before = snapshot();
    const response = await h.raw(old, repo, args);
    assert.notEqual(response.code, 0, `Predecessor accepted ${args.join(" ")}`);
    assert.deepEqual(snapshot(), before);
    results.push({ args, error: response.err, exit: response.code });
  }
  const daemon = await h.start(target, repo);
  const missing = await h.raw(target, repo, [
    "task",
    "run",
    "secret",
    "--input",
    "null",
  ]);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /KeyMissing/u);
  await h.cli(target, repo, ["daemon", "stop"]);
  await daemon.exited;
  renameSync(path.join(root, "keys-hidden"), path.join(root, "keys"));
  const resumed = await h.start(target, repo);
  const secret = await h.cli(target, repo, [
    "task",
    "run",
    "secret",
    "--input",
    "null",
  ]);
  Schema.asserts(TaskResult, secret);
  assert.equal(secret.result, true);
  await h.cli(target, repo, ["daemon", "stop"]);
  await resumed.exited;
  const result = {
    externalKeyAbsence:
      "typed failure, no silent replacement; original key still decrypts",
    kind: "actual-predecessor-writers-after-real-migration",
    limitations: [
      "SQLite shared-memory bytes may change on an old read-only open; logical data and all other source bytes were unchanged",
    ],
    predecessorSha256: createHash("sha256")
      .update(readFileSync(old))
      .digest("hex"),
    results,
    targetBuild: lifecycle.targetBuild,
    targetSha256: createHash("sha256")
      .update(readFileSync(target))
      .digest("hex"),
  };
  writeFileSync(
    path.join(process.env.EFFECTORY_UPGRADE_PROOF_DIR, "writers-results.json"),
    `${JSON.stringify(result, null, 2)}
`
  );
  console.log(result);
} finally {
  await h.close();
}

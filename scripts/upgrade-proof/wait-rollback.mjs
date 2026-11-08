/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Sequential executable proof and bounded polling. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { Effect } from "effect";

import { ownershipLayer } from "../../packages/platform-bun/src/ownership.ts";
import { verifyUpgradeRecoveryCopy } from "../../packages/platform-bun/src/upgrade-copy.ts";
import { seedFormat2, finishLegacySeed } from "./format2-seed.mjs";
import { harness } from "./process.mjs";

const oldBinary = process.env.EFFECTORY_PREVIOUS_BINARY;
const target = process.env.EFFECTORY_UPGRADE_BINARY;
let binary = oldBinary;
const root = mkdtempSync("/tmp/effectory-actual-upgrade-");
console.log({ root });
const repository = path.join(root, "source");
const restored = path.join(root, "restored");
const processes = [];
const h = harness(root);
const app = `
import { appendFileSync } from 'node:fs';
import { Application, Task, Workflow } from '@offtree/effectory-sdk';
import { Effect, Schema } from 'effect';
const once=Task.make({id:'once',version:1,input:Schema.Null,success:Schema.String,error:Schema.Never,replay:'manual'},()=>Effect.sync(()=>{appendFileSync('executions.txt','once\\n');return 'already-completed';}));
const after=Task.make({id:'after',version:1,input:Schema.String,success:Schema.String,error:Schema.Never,replay:'idempotent'},value=>Effect.succeed(value+'-continued'));
const workflow=Workflow.make({id:'recovery-proof',version:1,input:Schema.Null,success:Schema.String,error:Schema.Never},Effect.gen(function*(){const graph=yield* Workflow.Builder;const value=yield* graph.task('once',once,null);const approval=yield* graph.approval('review',{after:[value],prompt:'Continue restored run?',timeout:'1 hour'});return yield* graph.task('after',after,value,{after:[approval]});}));
export default Application.make({tasks:[once,after],workflows:[workflow]});
`;
async function cli(repo, args) {
  const child = Bun.spawn([binary, ...args, "--repository", repo, "--json"], {
    cwd: repo,
    stderr: "pipe",
    stdout: "pipe",
  });
  processes.push(child);
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(child.signalCode, null, `${args}: ${err}`);
    assert.equal(code, 0, `${args}: ${err}`);
    return out.trim() ? JSON.parse(out) : null;
  } finally {
    clearTimeout(timer);
  }
}
async function start(repo) {
  const child = Bun.spawn([binary, "daemon", "serve", "--repository", repo], {
    cwd: repo,
    stderr: Bun.file(path.join(root, `daemon-${processes.length}.log`)),
    stdout: "ignore",
  });
  processes.push(child);
  const deadline = Date.now() + 20_000;
  while (!existsSync(path.join(repo, ".effectory/daemon.json"))) {
    assert.equal(child.exitCode, null, "daemon exited");
    assert.ok(Date.now() < deadline, "daemon readiness timeout");
    await Bun.sleep(25);
  }
  return child;
}
async function waitOpen(repo, id) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const page = await cli(repo, ["run", "waits", id, "--status", "Open"]);
    if (page.items.length > 0) {
      return page.items[0];
    }
    assert.ok(Date.now() < deadline, "approval missing");
    await Bun.sleep(100);
  }
}
try {
  mkdirSync(repository);
  writeFileSync(path.join(repository, "effectory.ts"), app);
  const legacySeed = await seedFormat2(repository, root);
  const daemon = await start(repository);
  const run = await cli(repository, [
    "workflow",
    "run",
    "recovery-proof",
    "--input",
    "null",
    "--request-key",
    "original-host-copy",
    "--background",
  ]);
  const approval = await waitOpen(repository, run.runId);
  const before = await cli(repository, ["run", "get", run.runId]);
  const outputsBefore = await cli(repository, ["run", "outputs", run.runId]);
  assert.equal(
    readFileSync(path.join(repository, "executions.txt"), "utf-8"),
    `once
`
  );
  await cli(repository, ["daemon", "stop"]);
  await daemon.exited;
  binary = target;
  const { plan } = await cli(repository, ["upgrade", "plan"]);
  console.log({ plan });
  assert.equal(plan.status, "Ready");
  assert.equal(plan.work["execution.runs"], legacySeed ? 2 : 1);
  assert.equal(plan.source.storage, legacySeed?.plan.target.storage ?? 1);
  const applied = await cli(repository, ["upgrade", "apply", plan.planId]);
  console.log({ applied });
  assert.equal(applied.phase, "Complete");
  assert.deepEqual(
    await cli(repository, ["upgrade", "apply", plan.planId]),
    applied
  );
  const upgraded = await start(repository);
  await finishLegacySeed(h, target, repository, legacySeed);
  assert.deepEqual(
    await cli(repository, ["run", "outputs", run.runId]),
    outputsBefore
  );
  assert.equal(
    (
      await cli(repository, [
        "workflow",
        "run",
        "recovery-proof",
        "--input",
        "null",
        "--request-key",
        "original-host-copy",
        "--background",
      ])
    ).runId,
    run.runId
  );
  assert.equal((await waitOpen(repository, run.runId)).waitId, approval.waitId);
  await cli(repository, [
    "run",
    "approve",
    approval.waitId,
    "--request-key",
    "continue-upgraded",
  ]);
  assert.equal(
    (await cli(repository, ["run", "watch", run.runId])).result,
    "already-completed-continued"
  );
  assert.equal(
    readFileSync(path.join(repository, "executions.txt"), "utf-8"),
    `once
`
  );
  await cli(repository, ["daemon", "stop"]);
  await upgraded.exited;
  const manifest = JSON.parse(
    readFileSync(path.join(plan.recoveryCopy, "manifest.json"), "utf-8")
  );
  const copy = { digest: applied.acceptance.recoveryDigest, manifest };
  const owned = ownershipLayer(
    path.join(repository, ".effectory/state.sqlite.owner")
  );
  await Effect.runPromise(
    verifyUpgradeRecoveryCopy(plan.recoveryCopy, plan.planId, copy.digest).pipe(
      Effect.scoped,
      Effect.provide(owned)
    )
  );
  binary = oldBinary;
  cpSync(path.join(plan.recoveryCopy, "repository"), restored, {
    errorOnExist: true,
    force: false,
    recursive: true,
  });
  const rolledBack = await start(restored);
  await finishLegacySeed(h, oldBinary, restored, legacySeed);
  const retained = await cli(restored, ["run", "get", run.runId]);
  assert.equal(retained.revision, before.revision);
  assert.equal(retained.runId, before.runId);
  const outputsRestored = await cli(restored, ["run", "outputs", run.runId]);
  assert.deepEqual(outputsRestored, outputsBefore);
  const repeated = await cli(restored, [
    "workflow",
    "run",
    "recovery-proof",
    "--input",
    "null",
    "--request-key",
    "original-host-copy",
    "--background",
  ]);
  assert.equal(repeated.runId, run.runId);
  const restoredWait = await waitOpen(restored, run.runId);
  assert.equal(restoredWait.waitId, approval.waitId);
  await cli(restored, [
    "run",
    "approve",
    approval.waitId,
    "--request-key",
    "continue-restored",
  ]);
  const finished = await cli(restored, ["run", "watch", run.runId]);
  assert.equal(finished.status, "Succeeded");
  assert.equal(finished.result, "already-completed-continued");
  assert.equal(
    readFileSync(path.join(restored, "executions.txt"), "utf-8"),
    `once
`
  );
  await cli(restored, ["daemon", "stop"]);
  await rolledBack.exited;
  const result = {
    completedManualHandlerExecutions: 1,
    copyDigest: copy.digest,
    copyEntries: copy.manifest.entries.length,
    kind: "actual-old-new-upgrade-and-original-host-rollback",
    legacySeed,
    limitations: [
      "Waiting-run and rollback proof; lifecycle and offline-writer cases are recorded separately",
    ],
    predecessorSha256: createHash("sha256")
      .update(readFileSync(binary))
      .digest("hex"),
    preserved: [
      "accepted run identity",
      "pinned revision",
      "completed manual activity result",
      "pending approval identity",
      "submission request-key receipt",
    ],
    result: finished.result,
    revision: run.revision,
    runId: run.runId,
    sourceStorage: plan.source.storage,
    targetBuild: plan.target.build,
    targetSha256: createHash("sha256")
      .update(readFileSync(target))
      .digest("hex"),
  };
  writeFileSync(
    path.join(
      process.env.EFFECTORY_UPGRADE_PROOF_DIR,
      "wait-rollback-results.json"
    ),
    `${JSON.stringify(result, null, 2)}
`
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await h.close();
  for (const child of processes) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  console.log({ preservedRoot: root });
}

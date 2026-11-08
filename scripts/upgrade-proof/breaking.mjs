/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Sequential executable proof and bounded polling. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { seedFormat2, finishLegacySeed } from "./format2-seed.mjs";
import { harness } from "./process.mjs";

const oldBinary = process.env.EFFECTORY_PREVIOUS_BINARY;
const target = process.env.EFFECTORY_BREAKING_BINARY;
let binary = oldBinary;
const root = mkdtempSync("/tmp/effectory-breaking-upgrade-");
console.log({ root });
const repository = path.join(root, "source");
const processes = [];
const h = harness(root);
const app = `
import { appendFileSync, existsSync } from 'node:fs';
if(existsSync('forbid-legacy')) throw new Error('ARCHIVED-CODE-IMPORTED');
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
  assert.equal(plan.status, "Blocked");
  assert.equal(plan.source.storage, legacySeed?.plan.target.storage ?? 1);
  assert.ok(plan.blockers.length > 0);
  assert.equal(plan.revisions[0].disposition, "Archived");
  const refused = Bun.spawn(
    [
      target,
      "upgrade",
      "apply",
      plan.planId,
      "--repository",
      repository,
      "--json",
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  processes.push(refused);
  const [refusedCode, _refusedOut, refusedErr] = await Promise.all([
    refused.exited,
    new Response(refused.stdout).text(),
    new Response(refused.stderr).text(),
  ]);
  assert.equal(refusedCode, 5);
  assert.match(refusedErr, /no applicable certified transition/u);
  assert.equal(existsSync(plan.recoveryCopy), false);
  binary = oldBinary;
  const resumed = await start(repository);
  await finishLegacySeed(h, oldBinary, repository, legacySeed);
  assert.deepEqual(
    await cli(repository, ["run", "outputs", run.runId]),
    outputsBefore
  );
  await cli(repository, [
    "run",
    "approve",
    approval.waitId,
    "--request-key",
    "settle-before-breaking",
  ]);
  const finished = await cli(repository, ["run", "watch", run.runId]);
  assert.equal(finished.status, "Succeeded");
  const finalOutputs = await cli(repository, ["run", "outputs", run.runId]);
  await cli(repository, ["daemon", "stop"]);
  await resumed.exited;
  writeFileSync(path.join(repository, "forbid-legacy"), "yes");
  writeFileSync(
    path.join(repository, "effectory.ts"),
    app.replace(
      "if(existsSync('forbid-legacy')) throw new Error('ARCHIVED-CODE-IMPORTED');",
      "// New active source."
    )
  );
  binary = target;
  const { plan: ready } = await cli(repository, ["upgrade", "plan"]);
  assert.equal(ready.status, "Ready");
  assert.equal(ready.revisions[0].disposition, "Archived");
  const receipt = await cli(repository, ["upgrade", "apply", ready.planId]);
  assert.equal(receipt.phase, "Complete");
  const upgraded = await start(repository);
  assert.deepEqual(
    await cli(repository, ["run", "outputs", run.runId]),
    finalOutputs
  );
  assert.deepEqual(await cli(repository, ["run", "get", run.runId]), finished);
  const summary = await cli(repository, ["run", "summary", run.runId]);
  assert.equal(summary.data.status, "Succeeded");
  const description = Bun.spawn(
    [
      target,
      "task",
      "describe",
      "once",
      "--revision",
      run.revision,
      "--repository",
      repository,
      "--json",
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  processes.push(description);
  const [describeCode, _describeOut, describeErr] = await Promise.all([
    description.exited,
    new Response(description.stdout).text(),
    new Response(description.stderr).text(),
  ]);
  assert.equal(describeCode, 5);
  assert.match(
    describeErr,
    /no certified transition|unavailable for execution/u
  );
  const fresh = await cli(repository, [
    "task",
    "run",
    "after",
    "--input",
    '"new"',
  ]);
  assert.equal(fresh.result, "new-continued");
  assert.notEqual(fresh.revision, run.revision);
  await cli(repository, ["daemon", "stop"]);
  await upgraded.exited;
  const result = {
    archivedCodeLoaded: false,
    completedTransition: receipt.phase,
    describeExit: describeCode,
    historicalStatus: finished.status,
    kind: "actual-incompatible-host-fixture",
    limitations: [
      "Deliberately incompatible contract fixture; this v2 edge will not ship",
    ],
    newRunStatus: fresh.status,
    refusalExit: refusedCode,
    refusalStatus: plan.status,
    sourceBuild: ready.source.build,
    sourceStorage: ready.source.storage,
    targetBuild: ready.target.build,
    targetSha256: createHash("sha256")
      .update(readFileSync(target))
      .digest("hex"),
  };
  writeFileSync(
    path.join(process.env.EFFECTORY_UPGRADE_PROOF_DIR, "breaking-results.json"),
    `${JSON.stringify(result, null, 2)}
`
  );
  console.log(result);
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

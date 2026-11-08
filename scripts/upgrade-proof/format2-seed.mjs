/* oxlint-disable unicorn/no-await-expression-member -- Sequential executable proof. */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { harness, old } from "./process.mjs";

const application = `
import {appendFileSync} from 'node:fs';
import {Application,Task,Workflow} from '@offtree/effectory-sdk';
import {Effect,Schema} from 'effect';
const Once=Task.make({id:'legacy-seed-once',version:1,input:Schema.Null,success:Schema.String,error:Schema.Never,replay:'manual'},()=>Effect.sync(()=>{appendFileSync('legacy-seed-executions.txt','once\\n');return 'retained-legacy'}));
const Done=Task.make({id:'legacy-seed-done',version:1,input:Schema.String,success:Schema.String,error:Schema.Never,replay:'idempotent'},s=>Effect.succeed(s));
const Flow=Workflow.make({id:'legacy-seed',version:1,input:Schema.Null,success:Schema.String,error:Schema.Never},Effect.gen(function*(){const g=yield* Workflow.Builder;const result=yield* g.task('once',Once,null);const wait=yield* g.approval('hold',{after:[result],prompt:'Hold across two real upgrades',timeout:'1 hour'});return yield* g.task('done',Done,result,{after:[wait]});}));
export default Application.make({tasks:[Once,Done],workflows:[Flow]});
`;

/** Build predecessor storage through an actual legacy upgrade, with legacy work still pending. */
export async function seedFormat2(repository, root) {
  const bootstrap = process.env.EFFECTORY_BOOTSTRAP_BINARY;
  if (!bootstrap) {
    return null;
  }
  const source = path.join(repository, "effectory.ts");
  const original = readFileSync(source);
  const h = harness(root);
  try {
    writeFileSync(source, application);
    const daemon = await h.start(bootstrap, repository);
    const run = await h.cli(bootstrap, repository, [
      "workflow",
      "run",
      "legacy-seed",
      "--input",
      "null",
      "--background",
      "--request-key",
      "legacy-seed",
    ]);
    const waits = await h.until(
      "legacy seed approval",
      () =>
        h.cli(bootstrap, repository, [
          "run",
          "waits",
          run.runId,
          "--status",
          "Open",
        ]),
      (page) => page.items.length === 1
    );
    const outputs = await h.cli(bootstrap, repository, [
      "run",
      "outputs",
      run.runId,
    ]);
    await h.cli(bootstrap, repository, ["daemon", "stop"]);
    await daemon.exited;
    const { plan } = await h.cli(old, repository, ["upgrade", "plan"]);
    assert.equal(plan.status, "Ready");
    assert.equal(plan.source.storage, 1);
    const receipt = await h.cli(old, repository, [
      "upgrade",
      "apply",
      plan.planId,
    ]);
    assert.equal(receipt.phase, "Complete");
    return { outputs, plan, receipt, run, waitId: waits.items[0].waitId };
  } finally {
    await h.close();
    writeFileSync(source, original);
  }
}

export async function finishLegacySeed(h, binary, repository, seed) {
  if (!seed) {
    return;
  }
  assert.deepEqual(
    await h.cli(binary, repository, ["run", "outputs", seed.run.runId]),
    seed.outputs
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        path.join(
          repository,
          `.effectory/upgrade-history/${seed.plan.planId}.json`
        ),
        "utf-8"
      )
    ),
    seed.receipt
  );
  await h.cli(binary, repository, [
    "run",
    "approve",
    seed.waitId,
    "--request-key",
    "legacy-seed-approve",
  ]);
  const run = await h.cli(binary, repository, ["run", "watch", seed.run.runId]);
  assert.equal(run.status, "Succeeded");
  assert.equal(run.result, "retained-legacy");
  assert.equal(run.revision, seed.run.revision);
  assert.equal(
    readFileSync(path.join(repository, "legacy-seed-executions.txt"), "utf-8"),
    "once\n"
  );
}

/* oxlint-disable unicorn/no-await-expression-member -- Sequential executable proof. */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";

import { harness, old } from "./process.mjs";

/** Only the fields this proof reads; other CLI output is kept untouched. */
const RunReceipt = Schema.Struct({
  revision: Schema.optionalKey(Schema.Unknown),
  runId: Schema.String,
});
const WaitPage = Schema.Struct({ items: Schema.Array(Schema.Unknown) });
const OpenWait = Schema.Struct({ waitId: Schema.String });
const UpgradePlan = Schema.Struct({
  plan: Schema.Struct({
    planId: Schema.String,
    source: Schema.Struct({ storage: Schema.optionalKey(Schema.Unknown) }),
    status: Schema.optionalKey(Schema.Unknown),
    target: Schema.Struct({ storage: Schema.optionalKey(Schema.Unknown) }),
  }),
});
const UpgradeReceipt = Schema.Struct({
  phase: Schema.optionalKey(Schema.Unknown),
});
const FinishedRun = Schema.Struct({
  result: Schema.optionalKey(Schema.Unknown),
  revision: Schema.optionalKey(Schema.Unknown),
  status: Schema.optionalKey(Schema.Unknown),
});

const application = `
import {appendFileSync} from 'node:fs';
import {Application,Task,Workflow} from '@offtree/effectory-sdk';
import {Effect,Schema} from 'effect';
const Once=Task.make({id:'legacy-seed-once',version:1,input:Schema.Null,success:Schema.String,error:Schema.Never,replay:'manual'},()=>Effect.sync(()=>{appendFileSync('legacy-seed-executions.txt','once\\n');return 'retained-legacy'}));
const Done=Task.make({id:'legacy-seed-done',version:1,input:Schema.String,success:Schema.String,error:Schema.Never,replay:'idempotent'},s=>Effect.succeed(s));
const Flow=Workflow.make({id:'legacy-seed',version:1,input:Schema.Null,success:Schema.String,error:Schema.Never},Effect.gen(function*(){const g=yield* Workflow.Builder;const result=yield* g.task('once',Once,null);const wait=yield* g.approval('hold',{after:[result],prompt:'Hold across two real upgrades',timeout:'1 hour'});return yield* g.task('done',Done,result,{after:[wait]});}));
export default Application.make({tasks:[Once,Done],workflows:[Flow]});
`;

/**
 * Build predecessor storage through an actual legacy upgrade, with legacy work still pending.
 * @param {string} repository Repository to seed.
 * @param {string} root Proof root holding keys and daemon logs.
 */
export async function seedFormat2(repository, root) {
  const bootstrap = process.env.EFFECTORY_BOOTSTRAP_BINARY;
  if (bootstrap === undefined || bootstrap === "") {
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
    Schema.asserts(RunReceipt, run);
    const waits = await h.until(
      "legacy seed approval",
      async () => {
        const page = await h.cli(bootstrap, repository, [
          "run",
          "waits",
          run.runId,
          "--status",
          "Open",
        ]);
        Schema.asserts(WaitPage, page);
        return page;
      },
      (page) => page.items.length === 1
    );
    const outputs = await h.cli(bootstrap, repository, [
      "run",
      "outputs",
      run.runId,
    ]);
    await h.cli(bootstrap, repository, ["daemon", "stop"]);
    await daemon.exited;
    const planned = await h.cli(old, repository, ["upgrade", "plan"]);
    Schema.asserts(UpgradePlan, planned);
    const { plan } = planned;
    assert.equal(plan.status, "Ready");
    assert.equal(plan.source.storage, 1);
    const receipt = await h.cli(old, repository, [
      "upgrade",
      "apply",
      plan.planId,
    ]);
    Schema.asserts(UpgradeReceipt, receipt);
    assert.equal(receipt.phase, "Complete");
    const [wait] = waits.items;
    Schema.asserts(OpenWait, wait);
    return { outputs, plan, receipt, run, waitId: wait.waitId };
  } finally {
    await h.close();
    writeFileSync(source, original);
  }
}

/**
 * Completes the legacy run seeded by {@link seedFormat2} and checks it was retained.
 * @param {ReturnType<typeof harness>} h Process harness for the proof.
 * @param {string} binary Executable that now owns the repository.
 * @param {string} repository Seeded repository.
 * @param {Awaited<ReturnType<typeof seedFormat2>>} seed Result of {@link seedFormat2}.
 */
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
  Schema.asserts(FinishedRun, run);
  assert.equal(run.status, "Succeeded");
  assert.equal(run.result, "retained-legacy");
  assert.equal(run.revision, seed.run.revision);
  assert.equal(
    readFileSync(path.join(repository, "legacy-seed-executions.txt"), "utf-8"),
    "once\n"
  );
}

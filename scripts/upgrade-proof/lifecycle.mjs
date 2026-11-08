import { Database } from "bun:sqlite";
/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Sequential executable proof and bounded polling. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";

import { seedFormat2, finishLegacySeed } from "./format2-seed.mjs";
import { partialTransfer } from "./partial-transfer.mjs";
import { harness, old, target } from "./process.mjs";

const root = mkdtempSync("/tmp/effectory-upgrade-lifecycle-");
const repo = path.join(root, "source");
mkdirSync(repo);
console.log({ root });
const h = harness(root);
const app = `
import {appendFileSync,existsSync} from 'node:fs';
import {Application,Artifact,ArtifactStorage,ArtifactReader,ArtifactReadError,ArtifactUnavailable,Report,Task,Workflow,WorkflowSchedule,Vault} from '@offtree/effectory-sdk';
import {Effect,Schema,Redacted} from 'effect';
const audit=(v)=>Effect.sync(()=>appendFileSync('audit.jsonl',JSON.stringify(v)+'\\n'));
const Credentials=Vault.make({id:'credentials',secrets:{token:Schema.String}});
const Secret=Task.make({id:'secret',version:1,input:Schema.Null,success:Schema.Boolean,error:Vault.Errors,replay:'idempotent'},()=>Effect.gen(function*(){return Redacted.value(yield* Credentials.get('token'))==='CANARY-upgrade-secret-123456789'}));
const Echo=Task.make({id:'echo',version:1,input:Schema.Null,success:Schema.String,error:Schema.Never,replay:'idempotent'},()=>Effect.succeed('done'));
const Sleep=Workflow.make({id:'sleep',version:1,input:Schema.Null,success:Schema.String,error:Schema.Never},Effect.gen(function*(){const g=yield* Workflow.Builder;const s=yield* g.sleep('timer','90 seconds');return yield* g.task('done',Echo,null,{after:[s]})}));
const RetryError=Schema.TaggedStruct('RetryLater',{});
const Flaky=Task.make({id:'flaky',version:1,input:Schema.Null,success:Schema.String,error:RetryError,replay:'idempotent'},(_,ctx)=>Effect.gen(function*(){yield* audit({kind:'retry',attempt:ctx.attempt,key:ctx.key('external')});if(ctx.attempt===1)return yield* Effect.fail({_tag:'RetryLater'});return 'retried'}));
const Retry=Workflow.make({id:'retry',version:1,input:Schema.Null,success:Schema.String,error:RetryError},Effect.gen(function*(){const g=yield* Workflow.Builder;return yield* g.task('flaky',Flaky,null,{retry:{attempts:2,delay:'90 seconds',when:['RetryLater']}})}));
const Manual=Task.make({id:'manual',version:1,input:Schema.Null,success:Schema.String,error:Schema.Never,replay:'manual'},(_,ctx)=>Effect.gen(function*(){yield* audit({kind:'manual',attempt:ctx.attempt,attemptId:ctx.attemptId,key:ctx.key('external')});if(!existsSync('manual-finish'))return yield* Effect.never;return 'recovered'}));
const Data=Artifact.make({id:'data',version:1,schema:Schema.Int});
const Produce=Task.make({id:'produce',version:1,input:Schema.Null,success:Data.refSchema,error:Schema.Never,replay:'idempotent',outputs:{data:Data}},()=>Effect.gen(function*(){return yield* (yield* ArtifactStorage).publish(Data,42,{key:'main'})}));
const ReadErrors=Schema.Union([ArtifactUnavailable,ArtifactReadError]);
const Acquire=Task.make({id:'acquire',version:1,input:Data.refSchema,success:Data.refSchema,error:ReadErrors,replay:'idempotent'},ref=>Effect.gen(function*(){yield* (yield* ArtifactReader).metadata(Data,ref);return ref}));
const Read=Task.make({id:'read',version:1,input:Data.refSchema,success:Schema.Int,error:ReadErrors,replay:'idempotent'},ref=>Effect.gen(function*(){return yield* (yield* ArtifactReader).get(Data,ref)}));
const Consumer=Workflow.make({id:'consumer',version:1,input:Data.refSchema,success:Schema.Int,error:ReadErrors},Effect.gen(function*(){const g=yield* Workflow.Builder;const ref=yield* g.task('acquire',Acquire,yield* g.input(Data.refSchema));const approval=yield* g.approval('review',{after:[ref],prompt:'Keep pin',timeout:'1 hour'});return yield* g.task('read',Read,ref,{after:[approval]})}));
const Reporter=Task.make({id:'reporter',version:1,input:Report.sourceOf(Produce),success:Report.result(Schema.Int),error:ReadErrors,replay:'idempotent'},()=>Effect.gen(function*(){while(!existsSync('report-finish'))yield* Effect.sleep('100 millis');const history=yield* Report.History;const outcome=yield* history.outcome(Produce);if(outcome._tag!=='Succeeded')return {markdown:'failed',data:-1};const value=yield* (yield* ArtifactReader).get(Data,outcome.value);yield* audit({kind:'report',value});return {markdown:'# Retained',data:value}}));
const Scheduled=Task.make({id:'scheduled',version:1,input:Schema.Null,success:Schema.NullOr(WorkflowSchedule.Occurrence),error:Schema.Never,replay:'idempotent'},(_,ctx)=>Effect.gen(function*(){yield* audit({kind:'schedule',occurrence:ctx.occurrence});return ctx.occurrence??null}));
const ScheduleFlow=Workflow.make({id:'schedule-flow',version:1,input:Schema.Null,success:Schema.NullOr(WorkflowSchedule.Occurrence),error:Schema.Never},Effect.gen(function*(){const g=yield* Workflow.Builder;return yield* g.task('tick',Scheduled,null)}));
const schedule=WorkflowSchedule.make({id:'minute',cron:'* * * * *',input:null,workflow:ScheduleFlow,timeZone:'UTC',catchUp:{latestWithin:'1 hour'}});
export default Application.make({tasks:[Secret,Echo,Flaky,Manual,Produce,Acquire,Read,Reporter,Scheduled],workflows:[Sleep,Retry,Consumer],schedules:[schedule],reports:[Report.make({id:'report',target:Produce,task:Reporter,scope:'run',execution:{attemptTimeout:'5 minutes'}})],vaults:[Credentials]}).provide(Vault.layer(Credentials,Vault.local));
`;
writeFileSync(path.join(repo, "effectory.ts"), app);
const cli = (b, args) => h.cli(b, repo, args);
const audit = () =>
  existsSync(path.join(repo, "audit.jsonl"))
    ? readFileSync(path.join(repo, "audit.jsonl"), "utf-8")
        .trim()
        .split(`
`)
        .map((x) => JSON.parse(x))
    : [];
const dbRead = (sql) => {
  const db = new Database(path.join(repo, ".effectory/state.sqlite"), {
    readonly: true,
  });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
};
try {
  const legacySeed = await seedFormat2(repo, root);
  let daemon = await h.start(old, repo);
  await cli(old, ["vault", "init", "credentials"]);
  const secret = path.join(root, "secret.txt");
  writeFileSync(secret, "CANARY-upgrade-secret-123456789");
  await cli(old, [
    "vault",
    "put",
    "credentials",
    "token",
    "--file",
    secret,
    "--if-version",
    "0",
    "--request-key",
    "secret",
  ]);
  const producer = await cli(old, [
    "task",
    "run",
    "produce",
    "--input",
    "null",
    "--request-key",
    "produce",
  ]);
  const consumer = await cli(old, [
    "workflow",
    "run",
    "consumer",
    "--input",
    JSON.stringify(producer.result),
    "--background",
    "--request-key",
    "consumer",
  ]);
  const approval = await h.until(
    "consumer wait",
    () => cli(old, ["run", "waits", consumer.runId, "--status", "Open"]),
    (p) => p.items.length > 0
  );
  const sleep = await cli(old, [
    "workflow",
    "run",
    "sleep",
    "--input",
    "null",
    "--background",
    "--request-key",
    "sleep",
  ]);
  const retry = await cli(old, [
    "workflow",
    "run",
    "retry",
    "--input",
    "null",
    "--background",
    "--request-key",
    "retry",
  ]);
  await h.until(
    "retry backoff",
    () => audit(),
    (a) => a.some((x) => x.kind === "retry")
  );
  const manual = await cli(old, [
    "task",
    "run",
    "manual",
    "--input",
    "null",
    "--background",
    "--request-key",
    "manual",
  ]);
  await h.until(
    "manual entered",
    () => audit(),
    (a) => a.some((x) => x.kind === "manual")
  );
  daemon.kill("SIGKILL");
  await daemon.exited;
  daemon = await h.start(old, repo);
  const held = await h.until(
    "manual hold",
    () => cli(old, ["run", "recover", manual.runId]),
    (v) => v.state === "Recoverable"
  );
  const reports = await cli(old, ["report", "list", producer.runId]);
  assert.equal(reports.items.length, 1);
  await cli(old, ["daemon", "stop"]);
  await daemon.exited;
  const schedules = dbRead("SELECT * FROM host_schedules");
  const pins = dbRead("SELECT * FROM lake_consumer_pins");
  const rows = dbRead("SELECT * FROM host_reports");
  console.log({ held, pins, rows, schedules });
  assert.ok(pins.length > 0);
  assert.ok(rows.length > 0);
  if (legacySeed) {
    // Key export may checkpoint its store. Complete it before binding the plan's source identity.
    await cli(old, [
      "vault",
      "key",
      "export",
      "credentials",
      "--output",
      path.join(root, "partial-transfer-key.json"),
    ]);
  }
  const { plan } = await cli(target, ["upgrade", "plan"]);
  assert.equal(plan.source.storage, legacySeed?.plan.target.storage ?? 1);
  assert.equal(plan.status, "Ready", JSON.stringify(plan));
  const partial = legacySeed
    ? await partialTransfer(h, repo, root, plan)
    : null;
  const applied = await cli(target, ["upgrade", "apply", plan.planId]);
  assert.equal(applied.phase, "Complete");
  assert.deepEqual(dbRead("SELECT * FROM host_schedules"), schedules);
  assert.deepEqual(dbRead("SELECT * FROM lake_consumer_pins"), pins);
  assert.deepEqual(dbRead("SELECT * FROM host_reports"), rows);
  const due = Math.max(...schedules.map((s) => s.watermark)) + 65_000;
  if (Date.now() < due) {
    await Bun.sleep(due - Date.now());
  }
  daemon = await h.start(target, repo);
  await finishLegacySeed(h, target, repo, legacySeed);
  const protection = await cli(target, [
    "lake",
    "reclaim",
    "plan",
    "--artifact",
    producer.result.artifactId,
    "--version",
    String(producer.result.version),
  ]);
  assert.equal(protection.protectedBy.consumerVersions, 1);
  assert.equal(protection.protectedBy.reportVersions, 1);
  assert.equal(protection.candidates.length, 0);
  writeFileSync(path.join(repo, "report-finish"), "yes");

  const heldAgain = await h.until(
    "retained hold",
    () => cli(target, ["run", "recover", manual.runId]),
    (v) => v.state === "Recoverable"
  );
  assert.equal(heldAgain.token, held.token);
  assert.equal(audit().filter((x) => x.kind === "manual").length, 1);
  assert.equal(
    (await cli(target, ["task", "run", "secret", "--input", "null"])).result,
    true
  );
  for (const [kind, id, receipt, input] of [
    ["workflow", "sleep", sleep, null],
    ["workflow", "retry", retry, null],
    ["task", "manual", manual, null],
    ["task", "produce", producer, null],
    ["workflow", "consumer", consumer, producer.result],
  ]) {
    assert.equal(
      (
        await cli(target, [
          kind,
          "run",
          id,
          "--input",
          JSON.stringify(input),
          "--background",
          "--request-key",
          id,
        ])
      ).runId,
      receipt.runId
    );
  }
  writeFileSync(path.join(repo, "manual-finish"), "yes");
  const accepted = await cli(target, [
    "run",
    "recover",
    manual.runId,
    "--authorize",
    heldAgain.token,
    "--acknowledge-reexecution",
    "--request-key",
    "recover",
  ]);
  assert.equal(accepted.outcome, "Accepted");
  await cli(target, [
    "run",
    "approve",
    approval.items[0].waitId,
    "--request-key",
    "approve",
  ]);
  for (const [run, result] of [
    [sleep, "done"],
    [retry, "retried"],
    [manual, "recovered"],
    [consumer, 42],
  ]) {
    const finished = await cli(target, ["run", "watch", run.runId]);
    assert.equal(finished.status, "Succeeded");
    assert.equal(finished.result, result);
    assert.equal(finished.revision, run.revision);
  }
  const reportSummary = await cli(target, ["report", "wait", producer.runId]);
  assert.equal(reportSummary.Succeeded, 1);
  const afterReport = await cli(target, ["report", "list", producer.runId]);
  assert.equal(afterReport.items[0].reportId, reports.items[0].reportId);
  assert.equal(afterReport.items[0].reportRunId, reports.items[0].reportRunId);
  await h.until(
    "scheduled catch-up",
    () => audit(),
    (a) =>
      a.some(
        (x) =>
          x.kind === "schedule" &&
          Date.parse(x.occurrence.scheduledFor) > schedules[0].watermark
      )
  );
  await cli(target, ["daemon", "stop"]);
  await daemon.exited;
  const calls = audit();
  assert.deepEqual(
    calls.filter((x) => x.kind === "retry").map((x) => x.attempt),
    [1, 2]
  );
  const manualCalls = calls.filter((x) => x.kind === "manual");
  assert.equal(manualCalls.length, 2);
  assert.deepEqual(manualCalls[0], manualCalls[1]);
  assert.equal(calls.filter((x) => x.kind === "report").length, 1);
  const [afterSchedule] = dbRead("SELECT * FROM host_schedules");
  assert.equal(afterSchedule.generation, schedules[0].generation);
  assert.equal(afterSchedule.digest, schedules[0].digest);
  const result = {
    kind: "actual-old-new-lifecycle",
    legacySeed,
    manualEntries: manualCalls.length,
    partial,
    planId: plan.planId,
    preserved: [
      "sleep",
      "retry backoff",
      "manual hold and authorization",
      "report obligation/run identity",
      "reader pins",
      "report-source protection",
      "schedule generation and watermark",
      "encrypted vault and external key",
      "request-key receipts",
    ],
    reportCompletions: 1,
    retryAttempts: [1, 2],
    root,
    sourceBuild: plan.source.build,
    sourceStorage: plan.source.storage,
    targetBuild: plan.target.build,
    targetSha256: createHash("sha256")
      .update(readFileSync(target))
      .digest("hex"),
  };
  writeFileSync(
    path.join(
      process.env.EFFECTORY_UPGRADE_PROOF_DIR,
      "lifecycle-results.json"
    ),
    `${JSON.stringify(result, null, 2)}
`
  );
  console.log(result);
} finally {
  await h.close();
  console.log({ preservedRoot: root });
}

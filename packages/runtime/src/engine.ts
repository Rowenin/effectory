/* Sequential reconciliation preserves admission/cancellation order. Effect.map is not Array.map. */
/* eslint-disable no-await-in-loop, unicorn/no-array-method-this-argument */
import { realpathSync } from "node:fs";

import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { ArtifactStore } from "@effectory/sdk/artifact-store";
import type { Config } from "@effectory/sdk/effectory";
import { RuntimeError } from "@effectory/sdk/errors";
import type {
  ApprovalRecord,
  ArtifactRecord,
  RunRecord,
} from "@effectory/sdk/records";
import { Approval, Artifacts } from "@effectory/sdk/services";
import {
  Cause,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
} from "effect";
import { MalformedMessage } from "effect/cluster/ClusterError";
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine";
import * as SingleRunner from "effect/cluster/SingleRunner";
import * as SqlClient from "effect/sql/SqlClient";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as Workflow from "effect/workflow/Workflow";
import {
  WorkflowEngine,
  WorkflowInstance,
} from "effect/workflow/WorkflowEngine";

import { claimWorkspace } from "./host.ts";
import { EngineStore, SqlRuntimeStore } from "./sql-store.ts";
import {
  canonicalJson,
  digestJson,
  isTerminal,
  RuntimeStore,
} from "./store.ts";
import type { RegisteredTask } from "./task.ts";

const DecisionSchema = Schema.Struct({
  decidedAt: Schema.String,
  operator: Schema.String,
  outcome: Schema.Literals(["approved", "rejected"]),
  reason: Schema.optional(Schema.String),
});
const decisionDeferred = (key: string) =>
  DurableDeferred.make(`effectory/approval/${key}`, {
    success: DecisionSchema,
  });
const tagStoreFailure = Effect.catchDefect((cause) =>
  Effect.fail(
    new RuntimeError({
      cause,
      message: cause instanceof Error ? cause.message : String(cause),
    })
  )
);
type ErasedWorkflow = Workflow.Workflow<
  string,
  Workflow.AnyStructSchema,
  Schema.Top,
  Schema.Top
>;
const workflowOf = (task: RegisteredTask) =>
  task.workflow as unknown as ErasedWorkflow;
export interface SubmitRun {
  task: string;
  input: unknown;
  requestKey: string;
}
export interface DecideApproval {
  id: string;
  digest: string;
  revision: string;
  outcome: "approved" | "rejected";
  reason?: string | undefined;
  operator?: string | undefined;
}
export interface LocalEngine {
  readonly submit: (request: SubmitRun) => Promise<RunRecord>;
  readonly listRuns: () => Promise<RunRecord[]>;
  readonly inspectRun: (id: string) => Promise<RunRecord>;
  readonly cancelRun: (id: string) => Promise<RunRecord>;
  readonly resumeRun: (id: string) => Promise<RunRecord>;
  readonly listArtifacts: (runId?: string) => Promise<ArtifactRecord[]>;
  readonly getArtifact: (id: string) => Promise<ArtifactRecord>;
  readonly listApprovals: () => Promise<ApprovalRecord[]>;
  readonly inspectApproval: (id: string) => Promise<ApprovalRecord>;
  readonly decideApproval: (request: DecideApproval) => Promise<ApprovalRecord>;
  readonly close: () => Promise<void>;
}
export const openEngine = async <Services = never, Error = never>(options: {
  workspace: string;
  tasks: readonly RegisteredTask[];
  config?: Config<Services, Error>;
  execute?: boolean;
}): Promise<LocalEngine> => {
  // A short-lived sync connection checks ownership and revision before cluster registration/polling.
  const workspace = realpathSync(options.workspace);
  const preflight = new RuntimeStore(workspace);
  let release: () => void;
  try {
    release = claimWorkspace(preflight);
  } catch (error) {
    preflight.close();
    throw error;
  }
  const tasks = new Map(options.tasks.map((task) => [task.name, task]));
  const taskFor = (run: RunRecord) => {
    const task = tasks.get(run.task);
    if (!task || task.fingerprint.digest !== run.revision) {
      throw new Error(
        `Unfinished run ${run.id} requires task ${run.task} revision ${run.revision}`
      );
    }
    return task;
  };
  try {
    if (
      tasks.size !== options.tasks.length ||
      new Set(options.tasks.map((t) => t.workflow._tag)).size !== tasks.size
    ) {
      throw new Error("Task names and workflow names must be unique");
    }
    for (const run of options.execute === false ? [] : preflight.listRuns()) {
      if (!isTerminal(run.status)) {
        taskFor(run);
      }
    }
  } catch (error) {
    release();
    preflight.close();
    throw error;
  }
  const platform = Layer.mergeAll(BunServices.layer, BunHttpClient.layer);
  // Reusing this Layer object lets Effect memoize one client for the engine and application services.
  const sql = SqliteClient.layer({ filename: preflight.filename });
  const storeLayer = Layer.effect(
    EngineStore,
    Effect.map(SqlClient.SqlClient, (client) => new SqlRuntimeStore(client))
  );
  const configured = (options.config?.services ?? Layer.empty).pipe(
    Layer.provideMerge(platform)
  );
  const artifactsLayer = Layer.effect(
    ArtifactStore,
    Effect.gen(function* artifactStore() {
      const custom = yield* Effect.serviceOption(ArtifactStore);
      if (Option.isSome(custom)) {
        return custom.value;
      }
      const store = yield* EngineStore;
      return ArtifactStore.of({
        get: (id) => store.getArtifact(id).pipe(tagStoreFailure),
        list: (runId) => store.listArtifacts(runId).pipe(tagStoreFailure),
        publish: (o) =>
          store
            .publish(o.runId, o.name, o.value, o.schemaVersion)
            .pipe(tagStoreFailure),
      });
    })
  ).pipe(
    Layer.provideMerge(configured),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(sql)
  );
  const application = Layer.mergeAll(
    Layer.effect(
      Artifacts,
      Effect.map(ArtifactStore, (store) => ({
        publish: (o: {
          name: string;
          value: unknown;
          schemaVersion?: number;
        }) =>
          Effect.gen(function* publish() {
            const instance = yield* WorkflowInstance;
            return yield* store
              .publish({ ...o, runId: instance.executionId })
              .pipe(tagStoreFailure);
          }),
        workspace,
      }))
    ),
    Layer.effect(
      Approval,
      Effect.map(EngineStore, (store) => ({
        request: (o: { key: string; title: string; review: unknown }) =>
          Effect.gen(function* request() {
            const instance = yield* WorkflowInstance;
            const deferred = decisionDeferred(o.key);
            const token = yield* DurableDeferred.token(deferred);
            const active = yield* store
              .requestApproval(instance.executionId, o, token)
              .pipe(tagStoreFailure);
            if (!active) {
              return yield* Workflow.suspend(instance);
            }
            return yield* DurableDeferred.await(deferred);
          }),
      }))
    )
  ).pipe(Layer.provideMerge(artifactsLayer));
  const cluster = SingleRunner.layer({
    runnerStorage: "memory",
    shardingConfig: {
      entityMessagePollInterval: "100 millis",
      entityReplyPollInterval: "50 millis",
      entityTerminationTimeout: "2 seconds",
      shardsPerGroup: 1,
    },
  }).pipe(Layer.provideMerge(sql), Layer.provideMerge(platform));
  const native = ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(cluster),
    Layer.provideMerge(application)
  );
  // Guard the handler before any user code so a cancelled admission can be dispatched solely to record its native interruption.
  const guarded = Layer.effect(
    WorkflowEngine,
    Effect.gen(function* guardEngine() {
      const engine = yield* WorkflowEngine;
      const store = yield* EngineStore;
      return {
        ...engine,
        register: ((workflow, execute) =>
          engine.register(workflow, (payload, id) =>
            Effect.gen(function* guardedExecution() {
              const run = yield* store.requireRun(id);
              if (run.status === "cancelling" || isTerminal(run.status)) {
                const instance = yield* WorkflowInstance;
                return yield* Workflow.suspend(instance);
              }
              return yield* execute(payload, id);
            })
          )) as typeof engine.register,
      };
    })
  ).pipe(Layer.provideMerge(native));
  const registrations = options.tasks.length
    ? Layer.mergeAll(
        ...(options.tasks.map((t) => t.implementation) as [
          Layer.Layer<never, unknown, unknown>,
          ...Layer.Layer<never, unknown, unknown>[],
        ])
      )
    : Layer.empty;
  // Dynamic trusted manifests erase their service parameters. The host supplies platform and Effectory services.
  const live = (
    options.execute === false
      ? artifactsLayer
      : registrations.pipe(Layer.provideMerge(guarded))
  ) as Layer.Layer<WorkflowEngine | SqlRuntimeStore | ArtifactStore, unknown>;
  const runtime = ManagedRuntime.make(live);
  const runEffect = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
    runtime.runPromise(
      effect as Effect.Effect<
        A,
        E,
        WorkflowEngine | SqlRuntimeStore | ArtifactStore
      >
    );
  let store: SqlRuntimeStore;
  let artifacts: ArtifactStore["Service"];
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let maintenance: Promise<void> = Promise.resolve();
  let reconciling = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Engine is closed");
    }
  };
  const assertExecuting = () => {
    assertOpen();
    if (options.execute === false) {
      throw new Error("This runtime session does not execute workflows");
    }
  };
  // A malformed native reply is retried once on the next open, never every timer tick.
  // Store reads/writes remain outside this boundary so SQL and ownership failures propagate.
  const unreadableRuns = new Set<string>();
  const reconcileRun = async (run: RunRecord): Promise<RunRecord> => {
    if (isTerminal(run.status) || unreadableRuns.has(run.id)) {
      return run;
    }
    const workflow = workflowOf(taskFor(run));
    const polled = await runEffect(
      Effect.exit(
        Effect.flatMap(WorkflowEngine, (engine) =>
          engine.poll(workflow, run.id)
        )
      )
    );
    let inspectionError: string | undefined;
    if (Exit.isFailure(polled)) {
      const onlyCodecErrors =
        polled.cause.reasons.length > 0 &&
        polled.cause.reasons.every((reason) => {
          let error: unknown;
          if (Cause.isFailReason(reason)) {
            ({ error } = reason);
          } else if (Cause.isDieReason(reason)) {
            ({ defect: error } = reason);
          }
          // Native persisted defects lose their class/tag when decoded by Schema.Defect.
          const persistedCodecError =
            error instanceof Error &&
            error.name === "~effect/cluster/ClusterError/MalformedMessage" &&
            error.cause instanceof Error &&
            error.cause.name === "SchemaError";
          return (
            Schema.isSchemaError(error) ||
            MalformedMessage.is(error) ||
            persistedCodecError
          );
        });
      if (!onlyCodecErrors) {
        return runEffect(Effect.failCause(polled.cause));
      }
      inspectionError = `Native outcome unreadable; inspection retries on engine reopen: ${Cause.pretty(polled.cause)}`;
    }
    const result = Exit.isSuccess(polled) ? polled.value : Option.none();
    let encoded: unknown;
    if (
      Option.isSome(result) &&
      result.value._tag !== "Suspended" &&
      Exit.isSuccess(result.value.exit)
    ) {
      const success = result.value.exit.value;
      const encoding = await runEffect(
        Effect.exit(
          Effect.suspend(() =>
            Schema.encodeEffect(Schema.toCodecJson(workflow.successSchema))(
              success
            ).pipe(
              Effect.map((wire) => JSON.parse(canonicalJson(wire)) as unknown)
            )
          )
        )
      );
      if (Exit.isSuccess(encoding)) {
        encoded = encoding.value;
      } else {
        inspectionError = `Native workflow succeeded; result encoding failed: ${Cause.pretty(encoding.cause)}`;
      }
    }
    // Serialize index changes through the same SQL transaction machinery as all app records.
    return runEffect(
      store.sql
        .withTransaction(
          Effect.gen(function* reconcileOutcome() {
            const current = yield* store.requireRun(run.id);
            if (
              isTerminal(current.status) ||
              (Option.isNone(result) && !inspectionError)
            ) {
              return current;
            }
            delete current.inspectionError;
            if (inspectionError) {
              current.inspectionError = inspectionError;
            }
            if (Option.isNone(result)) {
              current.updatedAt = new Date().toISOString();
              const saved = yield* store.putRun(current);
              unreadableRuns.add(run.id);
              return saved;
            }
            const { value } = result;
            if (value._tag === "Suspended") {
              if (current.status !== "cancelling") {
                current.status = "suspended";
              }
            } else if (Exit.isSuccess(value.exit)) {
              if (!inspectionError) {
                current.result = encoded;
              }
              current.status = "succeeded";
            } else {
              current.status = Cause.hasInterruptsOnly(value.exit.cause)
                ? "cancelled"
                : "failed";
              current.error = Cause.pretty(value.exit.cause);
            }
            current.updatedAt = new Date().toISOString();
            return yield* store.putRun(current);
          })
        )
        .pipe(Effect.orDie)
    );
  };
  const dispatch = async (run: RunRecord) => {
    await runEffect(
      Effect.flatMap(WorkflowEngine, (engine) =>
        engine.execute(workflowOf(taskFor(run)), {
          discard: true,
          executionId: run.id,
          payload: run.input,
        })
      )
    );
    await runEffect(
      store.sql
        .withTransaction(
          Effect.gen(function* markDispatched() {
            const current = yield* store.requireRun(run.id);
            if (current.status === "admitted") {
              yield* store.putRun({
                ...current,
                status: "running",
                updatedAt: new Date().toISOString(),
              });
            }
          })
        )
        .pipe(Effect.orDie)
    );
  };
  const deliver = async (a: ApprovalRecord) => {
    if (!a.decision || !a.released || a.delivered || a.status === "cancelled") {
      return;
    }
    const run = await runEffect(store.requireRun(a.runId));
    if (run.status === "cancelling" || isTerminal(run.status)) {
      return;
    }
    await runEffect(
      DurableDeferred.succeed(decisionDeferred(a.key), {
        token: a.token as DurableDeferred.Token,
        value: a.decision,
      })
    );
    // 'delivered' means durably submitted to the engine, not workflow completion.
    await runEffect(
      store.sql
        .withTransaction(
          Effect.gen(function* markDelivered() {
            const current = yield* store.requireApproval(a.id);
            yield* store.putApproval({ ...current, delivered: true });
          })
        )
        .pipe(Effect.orDie)
    );
  };
  const interrupt = async (run: RunRecord) => {
    // Unknown native executions cannot be interrupted. Idempotent submission plus the handler guard closes that admission gap.
    await dispatch(run);
    await runEffect(
      Effect.flatMap(WorkflowEngine, (engine) =>
        engine.interrupt(workflowOf(taskFor(run)), run.id)
      )
    );
  };
  const reconcile = async () => {
    for (const run of await runEffect(store.listRuns())) {
      if (run.status === "admitted") {
        await dispatch(run);
      }
      if (run.status === "cancelling") {
        await interrupt(run);
      }
      await reconcileRun(await runEffect(store.requireRun(run.id)));
    }
    for (const approval of await runEffect(store.listApprovals())) {
      await deliver(approval);
    }
  };
  try {
    await runtime.context();
    store = await runEffect(EngineStore);
    artifacts = await runEffect(ArtifactStore);
    if (options.execute !== false) {
      await reconcile();
      timer = setInterval(() => {
        if (reconciling || closed) {
          return;
        }
        reconciling = true;
        maintenance = (async () => {
          try {
            await reconcile();
          } catch (error) {
            console.error("Effectory reconciliation failed", error);
          } finally {
            reconciling = false;
          }
        })();
      }, 200);
      timer.unref();
    }
  } catch (error) {
    try {
      await runtime.dispose();
    } finally {
      release();
      preflight.close();
    }
    throw error;
  }
  return {
    async cancelRun(id) {
      assertExecuting();
      const run = await reconcileRun(await runEffect(store.requireRun(id)));
      if (isTerminal(run.status)) {
        return run;
      }
      const cancelling = await runEffect(store.cancel(id));
      if (!isTerminal(cancelling.status)) {
        await interrupt(cancelling);
      }
      return reconcileRun(await runEffect(store.requireRun(id)));
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(timer);
      await maintenance;
      try {
        await runtime.dispose();
      } finally {
        release();
        preflight.close();
      }
    },
    async decideApproval(request) {
      assertOpen();
      const approval = await runEffect(store.decide(request));
      return runEffect(store.requireApproval(approval.id));
    },
    async getArtifact(id) {
      assertOpen();
      const a = await runEffect(artifacts.get(id));
      if (!a) {
        throw new Error(`Unknown artifact: ${id}`);
      }
      return a;
    },
    inspectApproval(id) {
      assertOpen();
      return runEffect(store.requireApproval(id));
    },
    async inspectRun(id) {
      assertOpen();
      const run = await runEffect(store.requireRun(id));
      return options.execute === false ? run : reconcileRun(run);
    },
    listApprovals() {
      assertOpen();
      return runEffect(store.listApprovals());
    },
    listArtifacts(runId) {
      assertOpen();
      return runEffect(artifacts.list(runId));
    },
    async listRuns() {
      assertOpen();
      const runs = await runEffect(store.listRuns());
      return options.execute === false
        ? runs
        : Promise.all(runs.map(reconcileRun));
    },
    async resumeRun(id) {
      assertExecuting();
      const run = await runEffect(store.resume(id));
      for (const approval of await runEffect(store.listApprovals())) {
        if (approval.runId === id) {
          await deliver(approval);
        }
      }
      return reconcileRun(run);
    },
    async submit(request) {
      assertExecuting();
      const task = tasks.get(request.task);
      if (!task) {
        throw new Error(`Unknown workflow: ${request.task}`);
      }
      if (!request.requestKey) {
        throw new Error("Request key is required");
      }
      const input = await runEffect(
        Schema.decodeUnknownEffect(task.workflow.payloadSchema)(request.input)
      );
      try {
        canonicalJson(input);
      } catch (error) {
        throw new Error("Task input must decode to bounded finite JSON data", {
          cause: error,
        });
      }
      const now = new Date().toISOString();
      const run = await runEffect(
        store.admit({
          createdAt: now,
          id: digestJson(["effectory-run-v1", request.requestKey]),
          input,
          requestKey: request.requestKey,
          revision: task.fingerprint.digest,
          status: "admitted",
          task: task.name,
          updatedAt: now,
        })
      );
      const approvals = await runEffect(store.listApprovals());
      if (
        !isTerminal(run.status) &&
        approvals.some(
          (approval) =>
            approval.runId === run.id &&
            approval.status === "approved" &&
            !approval.released
        )
      ) {
        throw new Error(
          `Use 'effectory run resume ${run.id}' to continue an approved run.`
        );
      }
      if (run.status === "admitted") {
        await dispatch(run);
      }
      return reconcileRun(await runEffect(store.requireRun(run.id)));
    },
  };
};

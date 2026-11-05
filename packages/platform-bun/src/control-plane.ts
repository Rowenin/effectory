import type { Application } from "@effectory/core";
import { decode } from "@effectory/core/internal/boundary";
import { OperationError } from "@effectory/runtime/protocol";
import { ControlPlane } from "@effectory/runtime/rpc";
import type { ServerHello } from "@effectory/runtime/rpc";
import { Clock, Context, Effect, Schema } from "effect";

import { Catalog } from "./catalog.ts";
import { listDefinitions } from "./definition-discovery.ts";
import { doctor } from "./doctor.ts";
import { ExtensionManager } from "./extension-manager.ts";
import { ghLayer } from "./extension-source.ts";
import { extensionUpdates } from "./extension-updates.ts";
import { graphPlan } from "./graph-plan.ts";
import { HostStore } from "./host-store.ts";
import { Lake } from "./lake.ts";
import { validatePolicies } from "./policies.ts";
import { runOutputs } from "./run-outputs.ts";
import { createRunWatcher } from "./run-watch.ts";
import { Runner } from "./runner.ts";

export const ServerIdentity = Context.Service<{
  readonly repositoryId: string;
  readonly instanceId: string;
  readonly directory: string;
  readonly shutdown: (deadline: number) => void;
}>("effectory/ServerIdentity");
const limits = {
  activeRuns: 1000,
  activeTaskHandlers: 32,
  artifactBytes: 1_048_576,
  artifactProjectionBytes: 1_048_576,
  bundleBytes: 16_777_216,
  cancellationReceiptsPerRun: 64,
  daemonInstanceHistory: 10_000,
  declaredSchedules: 128,
  discoveryDefinitions: 10_000,
  extensionArchiveBytes: 16_777_216,
  extensionArchiveEntries: 512,
  extensionExpandedBytes: 67_108_864,
  fanOutItems: 1000,
  finalizationGraceMs: 2000,
  graphDepth: 16,
  graphExpandedNodes: 10_000,
  graphNodesPerScope: 1000,
  httpBatchRequests: 16,
  httpInFlightRequests: 32,
  inspectionPageBytes: 1_048_576,
  installedExtensions: 128,
  jsonDepth: 64,
  jsonValues: 100_000,
  lakePageBytes: 2_097_152,
  lakeQueryBytes: 65_536,
  lakeQueryDepth: 8,
  lakeQueryTerms: 64,
  lakeQueryTimeMs: 250,
  lakeScanBytes: 16_777_216,
  lakeScanRows: 10_000,
  observerBatchEvents: 16,
  observerBufferChunks: 4,
  observers: 16,
  outputPageBytes: 2_097_152,
  pageSize: 200,
  removedSchedules: 1024,
  requestBytes: 1_048_576,
  resultBytes: 1_048_576,
  retainedRevisions: 128,
  retryAttempts: 10,
  scheduleGraceMs: 60_000,
  scheduleHistoryEntries: 1000,
  scheduleMissedCount: 10_000,
  scheduleMutationReceipts: 256,
  scheduleTickMs: 1000,
  shutdownFinalizationMs: 2000,
  telemetryBytesPerRun: 1_048_576,
  telemetryEntriesPerRun: 1000,
  telemetryEntryBytes: 8192,
  waitContextBytes: 65_536,
  waitPromptBytes: 8192,
  waitSchemaBytes: 65_536,
  workflowConcurrency: 100,
};
const notFound = () =>
  new OperationError({ code: "NotFound", message: "Definition was not found" });
const json = (value: unknown) => Schema.decodeUnknownSync(Schema.Json)(value);
const boundary = <A>(action: () => A) =>
  Effect.try({
    catch: () =>
      new OperationError({
        code: "InvalidInput",
        message: "Definition or input cannot be represented at this boundary",
      }),
    try: action,
  });

function definition(
  registry: typeof Application.Registry.Service,
  kind: "task" | "workflow",
  id: string
) {
  return kind === "task"
    ? registry.tasks.get(id)
    : registry.workflows.get(id)?.definition;
}
const describe = (kind: "task" | "workflow", id: string, revision?: string) =>
  Effect.gen(function* () {
    const catalog = yield* Catalog;
    const application = yield* catalog.get(revision);
    const target = definition(application.registry, kind, id);
    if (!target) {
      return yield* notFound();
    }
    return yield* boundary(() =>
      json({
        error: Schema.toJsonSchemaDocument(target.errorSchema),
        id,
        input: Schema.toJsonSchemaDocument(target.inputSchema),
        revision: application.revision,
        success: Schema.toJsonSchemaDocument(target.successSchema),
        version: target.spec.version,
        ...(target.kind === "Task"
          ? {
              providerId: target.providerId ?? null,
              replay: target.spec.replay,
            }
          : {}),
      })
    );
  });
const validate = (
  kind: "task" | "workflow",
  id: string,
  input: Schema.Json,
  revision?: string
) =>
  Effect.gen(function* () {
    const catalog = yield* Catalog;
    const application = yield* catalog.get(revision);
    const target = definition(application.registry, kind, id);
    if (!target) {
      return yield* notFound();
    }
    const validation = yield* Effect.exit(
      boundary(() => {
        decode(target.inputSchema, input);
        if (kind === "workflow") {
          validatePolicies(application.registry, id);
        }
      })
    );
    return {
      issues:
        validation._tag === "Success"
          ? []
          : ["Input or execution policy is invalid or unsupported"],
      revision: application.revision,
      valid: validation._tag === "Success",
    };
  });

export const controlPlaneLayer = ControlPlane.toLayer(
  Effect.gen(function* () {
    const store = yield* HostStore;
    const watcher = createRunWatcher(store);
    const runner = yield* Runner;
    const lake = yield* Lake;
    const catalog = yield* Catalog;
    const identity = yield* ServerIdentity;
    const extensions = yield* ExtensionManager;
    const hello = () =>
      Effect.map(
        extensions.installed,
        (installed): typeof ServerHello.Type => ({
          capabilities: [
            "schedule.v1",
            "graph.v1",
            "task.v1",
            "lake.ast.v1",
            "extension.github.v1",
            "inspection.paging.v1",
            "run.watch.v1",
            "system.drain.v1",
            "system.doctor.v1",
          ],
          installedRegistryRevision: installed.revision,
          instanceId: identity.instanceId,
          limits,
          protocolMajor: 1,
          repositoryId: identity.repositoryId,
          revision: installed.applicationRevision,
          serverVersion: "0.0.0",
        })
      );
    const inventory = Effect.gen(function* () {
      const installed = yield* extensions.installed;
      const application = yield* catalog.get(installed.applicationRevision);
      return {
        applicationRevision: application.revision,
        extensions: Object.entries(installed.lock.packages).map(
          ([id, pkg]) => ({
            bindingName: installed.lock.roots[id]?.bindingName ?? null,
            digest: pkg.archiveDigest,
            id,
            root: installed.lock.roots[id] !== undefined,
            selected: application.registry.extensions.some(
              (extension) => extension.id === id
            ),
            source: pkg.source,
            version: pkg.manifest.version,
          })
        ),
        installedRevision: installed.revision,
        lock: installed.lock,
      };
    });
    return {
      ExtensionAdd: (request) =>
        extensions.accept({ ...request, kind: "Add" }, "owner"),
      ExtensionDescribe: ({ id }) =>
        Effect.gen(function* () {
          const { lock, ...listed } = yield* inventory;
          const summary = listed.extensions.find((item) => item.id === id);
          const pkg = lock.packages[id];
          if (!summary || !pkg) {
            return yield* notFound();
          }
          return {
            applicationRevision: listed.applicationRevision,
            installedRevision: listed.installedRevision,
            package: pkg,
            summary,
          };
        }),
      ExtensionList: () =>
        inventory.pipe(
          Effect.map(
            ({
              applicationRevision,
              installedRevision,
              extensions: items,
            }) => ({
              applicationRevision,
              extensions: items,
              installedRevision,
            })
          )
        ),
      ExtensionOutdated: (request) =>
        extensions.installed.pipe(
          Effect.flatMap(({ lock }) => extensionUpdates(lock, request)),
          Effect.provide(ghLayer)
        ),
      ExtensionRemove: (request) =>
        extensions.accept({ ...request, kind: "Remove" }, "owner"),
      ExtensionUpdate: (request) =>
        extensions.accept({ ...request, kind: "Update" }, "owner"),
      LakeGet: ({ artifactId, version }) => lake.get(artifactId, version),
      LakeQuery: ({ query, cursor }) => lake.query(query, "owner", cursor),
      LakeVersions: (request) => lake.versions(request, "owner"),
      OperationGet: ({ operationId }) => extensions.get(operationId, "owner"),
      OperationList: (request) => extensions.operations(request, "owner"),
      RunCancel: (request) => store.cancelRequest(request, "owner"),
      RunEvents: (request) => store.eventPage(request, "owner"),
      RunGet: ({ runId }) => store.getRun(runId, "owner"),
      RunList: (request) => store.history(request, "owner"),
      RunLogs: (request) => store.logPage(request, "owner"),
      RunOutputs: (request) => runOutputs(request, "owner"),
      RunWatch: ({ runId, afterSequence }) =>
        watcher.watch(runId, "owner", afterSequence),
      ScheduleGet: ({ scheduleId }) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            store.scheduleGet(scheduleId, "owner", now, catalog.active)
          )
        ),
      ScheduleHistory: (request) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => store.scheduleHistory(request, "owner", now))
        ),
      ScheduleList: (request) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => store.scheduleList(request, "owner", now))
        ),
      SchedulePause: (request) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            store.scheduleMutation(request, true, "owner", now, catalog.active)
          )
        ),
      ScheduleResume: (request) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            store.scheduleMutation(request, false, "owner", now, catalog.active)
          )
        ),
      SystemDoctor: () => doctor(identity.directory),
      SystemDrain: (request) =>
        Effect.gen(function* () {
          const receipt = yield* store.drain(request);
          if (receipt.instanceId === identity.instanceId) {
            yield* runner.stopAccepting;
            yield* extensions.stopAccepting;
            identity.shutdown(receipt.deadline);
          }
          return receipt;
        }).pipe(Effect.uninterruptible),
      SystemHello: (request) =>
        request.repositoryId === identity.repositoryId
          ? hello()
          : Effect.fail(
              new OperationError({
                code: "Unauthorized",
                message: "Repository identity does not match",
              })
            ),
      SystemStatus: () =>
        Effect.gen(function* () {
          const base = yield* hello();
          const daemon = yield* store.daemonStatus();
          const scheduler = yield* store.schedulerStatus(
            yield* Clock.currentTimeMillis
          );
          return {
            ...base,
            daemon,
            observers: watcher.active,
            readiness:
              daemon.drain === null
                ? ("Ready" as const)
                : ("Draining" as const),
            scheduler,
          };
        }),
      TaskDescribe: ({ id, revision }) => describe("task", id, revision),
      TaskList: (request) => listDefinitions("task", request, "owner"),
      TaskRun: ({ id, ...request }) =>
        runner.submit({ ...request, kind: "task", targetId: id }, "owner"),
      TaskValidate: ({ id, revision, input }) =>
        validate("task", id, input, revision),
      WaitApprove: (request) =>
        runner.settle({ ...request, operation: "approve" }, "owner"),
      WaitGet: ({ waitId }) => store.getWait(waitId, "owner"),
      WaitList: (request) => store.waitPage(request, "owner"),
      WaitReject: ({ reason, ...request }) =>
        runner.settle(
          { ...request, input: reason ?? null, operation: "reject" },
          "owner"
        ),
      WaitRespond: (request) =>
        runner.settle({ ...request, operation: "respond" }, "owner"),
      WaitSignal: ({ payload, ...request }) =>
        runner.settle(
          { ...request, input: payload, operation: "signal" },
          "owner"
        ),
      WorkflowDescribe: ({ id, revision }) =>
        describe("workflow", id, revision),
      WorkflowList: (request) => listDefinitions("workflow", request, "owner"),
      WorkflowPlan: ({ id, input, revision }) =>
        Effect.gen(function* () {
          const checked = yield* validate("workflow", id, input, revision);
          if (!checked.valid) {
            return yield* new OperationError({
              code: "InvalidInput",
              message: "Workflow input does not match its schema",
            });
          }
          const application = yield* catalog.get(checked.revision);
          const workflow = application.registry.workflows.get(id);
          if (!workflow) {
            return yield* notFound();
          }
          return yield* boundary(() =>
            json({
              extensions: application.registry.extensions,
              id,
              nodes: graphPlan(workflow.graph, application.registry),
              revision: checked.revision,
            })
          );
        }),
      WorkflowRun: ({ id, ...request }) =>
        runner.submit({ ...request, kind: "workflow", targetId: id }, "owner"),
      WorkflowValidate: ({ id, revision, input }) =>
        validate("workflow", id, input, revision),
    };
  })
);

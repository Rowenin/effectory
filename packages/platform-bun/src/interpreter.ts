/* oxlint-disable no-use-before-define */
// Graph and node interpreters are mutually recursive over bounded graph scopes.
import {
  Ref,
  TaskRuntimeError,
  Workflow as WorkflowAuthoring,
} from "@effectory/core";
import type {
  Application,
  Task,
  Workflow as GraphWorkflow,
} from "@effectory/core";
import {
  canonical,
  decode,
  identifier,
} from "@effectory/core/internal/boundary";
import type { Boundary } from "@effectory/core/internal/boundary";
import { durationMillis } from "@effectory/core/internal/policy";
import type { Run } from "@effectory/runtime/protocol";
import { Cause, Effect, Layer, Logger, Result, Schedule, Schema } from "effect";
import {
  Activity,
  DurableClock,
  DurableDeferred,
  Workflow,
} from "effect/workflow";
import {
  WorkflowEngine,
  WorkflowInstance,
} from "effect/workflow/WorkflowEngine";

import { Catalog } from "./catalog.ts";
import { ExecutionDeadline, withDeadline } from "./deadline.ts";
import {
  ExecutionFailure,
  boundary,
  hostFailure,
  encode,
} from "./execution-boundary.ts";
import { ExecutionResources } from "./execution-resources.ts";
import {
  awaitDependencies,
  awaitReferences,
  invocationPath,
  nodeCodec,
  nodeResult,
  nodeResultName,
  resolve,
} from "./graph-execution.ts";
import type { GraphEnvironment, ScopeValues } from "./graph-execution.ts";
import { HostStore } from "./host-store.ts";
import { Lake } from "./lake.ts";
import { taskLogger } from "./task-logger.ts";

export const execution = Workflow.make("EffectoryExecution/v1", {
  error: ExecutionFailure,
  idempotencyKey: ({ runId }) => runId,
  payload: { runId: Schema.String },
  success: Schema.Json,
});
export const notification = (nodeId: string) =>
  DurableDeferred.make(`wait/${nodeId}`, { success: Schema.String });

function taskContext(
  run: Run,
  task: Application.RuntimeTask,
  nodeId: string,
  attempt: number,
  store: typeof HostStore.Service,
  lake: typeof Lake.Service
): Task.RuntimeContext {
  const identity: Task.Identity = {
    attempt,
    attemptId: `${run.runId}/${nodeId}/${attempt}`,
    invocationPath: nodeId,
    revision: run.revision,
    runId: run.runId,
    taskId: task.id,
    taskVersion: task.spec.version,
  };
  let progressIndex = 0;
  return {
    ...identity,
    ...(run.schedule === undefined
      ? {}
      : { occurrence: Object.freeze({ ...run.schedule }) }),
    key: (name) => canonical([run.runId, nodeId, identifier(name)]),
    progress: (update) =>
      Effect.sync(() => {
        progressIndex += 1;
        store.telemetry(
          run.runId,
          `progress/${nodeId}/${attempt}/${progressIndex}`,
          "Progress",
          {
            attempt,
            nodeId,
            ...update,
          }
        );
      }),
    publish: (name, artifact, value, options) =>
      lake.publish(identity, name, artifact, value, options),
  };
}

type RuntimeEffect = Effect.Effect<
  unknown,
  ExecutionFailure,
  | typeof HostStore.Service
  | typeof Lake.Service
  | typeof ExecutionResources.Service
  | WorkflowEngine
  | WorkflowInstance
>;

export const leafExecution = Workflow.make("EffectoryTask/v1", {
  error: ExecutionFailure,
  idempotencyKey: ({ runId, nodeId }) => canonical([runId, nodeId]),
  payload: {
    attemptTimeout: Schema.NullOr(Schema.String),
    deadline: Schema.NullOr(Schema.Finite),
    input: Schema.Json,
    nodeId: Schema.String,
    permits: Schema.Array(
      Schema.Struct({ concurrency: Schema.Int, path: Schema.String })
    ),
    retry: Schema.NullOr(
      Schema.Struct({
        attempts: Schema.Int,
        delay: Schema.String,
        when: Schema.Array(Schema.String),
      })
    ),
    runId: Schema.String,
    taskId: Schema.String,
  },
  success: Schema.Json,
});

const leafLayer = leafExecution.toLayer(
  ({
    runId,
    nodeId,
    taskId,
    input,
    permits,
    retry,
    deadline,
    attemptTimeout,
  }) =>
    Effect.gen(function* () {
      const store = yield* HostStore;
      const lake = yield* Lake;
      const catalog = yield* Catalog;
      const resources = yield* ExecutionResources;
      const run = yield* store
        .getRun(runId)
        .pipe(Effect.mapError(() => hostFailure("Run lookup failed")));
      const { registry } = yield* catalog
        .get(run.revision)
        .pipe(
          Effect.mapError(() => hostFailure("Pinned revision unavailable"))
        );
      const task = registry.tasks.get(taskId);
      if (!task) {
        return yield* hostFailure("Task is unavailable");
      }
      for (let attempt = 1; ; attempt += 1) {
        let body = Effect.gen(function* () {
          const admission = yield* store
            .admitAttempt(runId, nodeId, attempt, task.spec.replay, {
              ...(deadline === null ? {} : { deadline }),
              ...(attemptTimeout === null
                ? {}
                : { attemptTimeout: durationMillis(attemptTimeout) }),
            })
            .pipe(
              Effect.mapError(() => hostFailure("Attempt admission failed"))
            );
          if (admission === "NeedsAttention") {
            return yield* Workflow.suspend(yield* WorkflowInstance);
          }
          if (admission === "Cancelled" || admission === "TimedOut") {
            return yield* new ExecutionFailure({
              category: "Control",
              detail: null,
              outcome: admission,
            });
          }
          const startedAt = yield* store
            .attemptStartedAt(runId, nodeId, attempt)
            .pipe(
              Effect.mapError(() =>
                hostFailure("Attempt timestamp lookup failed")
              )
            );
          const attemptDeadline = Math.min(
            deadline ?? Number.POSITIVE_INFINITY,
            attemptTimeout === null
              ? Number.POSITIVE_INFINITY
              : startedAt + durationMillis(attemptTimeout)
          );
          let handler = task
            .execute(
              input,
              taskContext(run, task, nodeId, attempt, store, lake)
            )
            .pipe(
              // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- This composes an Effect, not a Promise.
              Effect.catch((error) => {
                if (error instanceof TaskRuntimeError) {
                  return Effect.fail(hostFailure(error.message, error.code));
                }
                return boundary(() => encode(task.errorSchema, error)).pipe(
                  Effect.flatMap((detail) =>
                    Effect.fail(
                      new ExecutionFailure({
                        category: "Domain",
                        detail,
                        outcome: "Failed",
                      })
                    )
                  )
                );
              })
            );
          if (Number.isFinite(attemptDeadline)) {
            handler = handler.pipe(
              Effect.timeoutOrElse({
                duration: Math.max(0, attemptDeadline - Date.now()),
                orElse: () =>
                  Effect.fail(
                    new ExecutionFailure({
                      category: "Control",
                      detail: { deadline: attemptDeadline, nodeId },
                      outcome: "TimedOut",
                    })
                  ),
              })
            );
          }
          const result = yield* handler.pipe(
            Effect.provideService(
              Logger.CurrentLoggers,
              new Set([taskLogger(store, runId, nodeId, attempt)])
            )
          );
          return yield* boundary(() => encode(task.successSchema, result));
        });
        body = resources.global.withPermits(1)(resources.track(runId, body));
        for (const permit of permits.toReversed()) {
          body = resources
            .permits(runId, permit.path, permit.concurrency)
            .withPermits(1)(body);
        }
        const outcome = yield* Activity.make({
          error: ExecutionFailure,
          execute: body,
          interruptRetryPolicy: Schedule.recurs(0),
          name: `handler/${attempt}`,
          success: Schema.Json,
        }).pipe(Effect.result);
        if (Result.isSuccess(outcome)) {
          return outcome.success;
        }
        const error = outcome.failure;
        const decodedError =
          error.category === "Domain"
            ? yield* boundary(() => decode(task.errorSchema, error.detail))
            : null;
        const tag =
          decodedError !== null &&
          typeof decodedError === "object" &&
          "_tag" in decodedError
            ? decodedError._tag
            : undefined;
        if (
          !retry ||
          attempt >= retry.attempts ||
          error.category !== "Domain" ||
          typeof tag !== "string" ||
          !retry.when.includes(tag)
        ) {
          return yield* error;
        }
        const retryDeadline = yield* Activity.make({
          execute: Effect.sync(() => Date.now() + durationMillis(retry.delay)),
          interruptRetryPolicy: Schedule.recurs(0),
          name: `retry/${attempt}`,
          success: Schema.Finite,
        });
        yield* store
          .appendEvent(runId, `retry/${nodeId}/${attempt}`, "RetryScheduled", {
            attempt: attempt + 1,
            deadline: retryDeadline,
            nodeId,
          })
          .pipe(Effect.orDie);
        yield* DurableClock.sleep({
          // Await the named durable clock even when overdue, so a pending old
          // clock delivery cannot preempt the next attempt after offline time.
          duration: Math.max(1, retryDeadline - Date.now()),
          inMemoryThreshold: 0,
          name: `retry/${attempt}`,
        });
      }
    })
);

function invokeTask(
  run: Run,
  nodeId: string,
  task: Application.RuntimeTask,
  input: unknown,
  environment: GraphEnvironment,
  options: GraphWorkflow.NodeOptions = {}
) {
  return Effect.gen(function* () {
    const encoded = yield* boundary(() => encode(task.inputSchema, input));
    const deadline = yield* ExecutionDeadline;
    const payload = {
      attemptTimeout: options.attemptTimeout ?? null,
      deadline: Number.isFinite(deadline) ? deadline : null,
      input: encoded,
      nodeId,
      permits: environment.permits,
      retry: options.retry ?? null,
      runId: run.runId,
      taskId: task.id,
    };
    const id = yield* leafExecution.executionId(payload);
    const store = yield* HostStore;
    yield* store
      .registerInvocation(run.runId, nodeId, id, payload)
      .pipe(
        Effect.mapError(() => hostFailure("Task dispatch registration failed"))
      );
    const result = yield* leafExecution.execute(payload);
    return yield* boundary(() => decode(task.successSchema, result));
  });
}

function registerWait(
  run: Run,
  node: GraphWorkflow.WaitNode,
  environment: GraphEnvironment
) {
  return Effect.gen(function* () {
    const store = yield* HostStore;
    const nodeId = invocationPath(environment, node.id);
    const codec = node.schema;
    return yield* Activity.make({
      error: ExecutionFailure,
      execute: Effect.gen(function* () {
        const context = yield* boundary(() =>
          Schema.decodeUnknownSync(Schema.Json)(
            resolve(node.context ?? null, environment)
          )
        );
        const schema = codec
          ? yield* boundary(() =>
              Schema.decodeUnknownSync(Schema.Json)(
                Schema.toJsonSchemaDocument(codec)
              )
            )
          : undefined;
        const deadline = yield* boundary(
          () => Date.now() + durationMillis(node.timeout)
        );
        const kinds = {
          Approval: "approval",
          Input: "input",
          Signal: "signal",
          SignalRegistration: "signal",
        } as const;
        const wait = yield* store
          .openWait({
            context,
            deadline,
            kind: kinds[node.kind],
            nodeId,
            runId: run.runId,
            ...(node.prompt === undefined ? {} : { prompt: node.prompt }),
            ...(schema === undefined ? {} : { schema }),
          })
          .pipe(
            Effect.mapError((error) =>
              hostFailure("Wait registration failed", error.code)
            )
          );
        return wait.waitId;
      }),
      interruptRetryPolicy: Schedule.recurs(0),
      name: `register/${nodeId}`,
      success: Schema.String,
    });
  });
}

function awaitWait(run: Run, nodeId: string, waitId: string, codec?: Boundary) {
  return Effect.gen(function* () {
    const store = yield* HostStore;
    yield* DurableDeferred.await(notification(nodeId));
    const wait = yield* store
      .getWait(waitId)
      .pipe(Effect.mapError(() => hostFailure("Wait lookup failed")));
    if (
      wait.status === "Rejected" ||
      wait.status === "TimedOut" ||
      wait.status === "Cancelled"
    ) {
      return yield* new ExecutionFailure({
        category: "Control",
        detail: wait.payload,
        outcome: wait.status,
      });
    }
    if (wait.status === "Open") {
      return yield* hostFailure("Wait notification preceded its decision");
    }
    yield* store
      .project(run.runId, "Running")
      .pipe(Effect.mapError(() => hostFailure("Run projection failed")));
    return codec
      ? yield* boundary(() => decode(codec, wait.payload))
      : { _tag: "ApprovalPermit" };
  });
}

export function stopInvocations(runId: string) {
  return Effect.gen(function* () {
    const store = yield* HostStore;
    const engine = yield* WorkflowEngine;
    const resources = yield* ExecutionResources;
    yield* store.fence(runId).pipe(Effect.orDie);
    let quiescent = resources.active(runId) === 0;
    for (const invocation of yield* store
      .invocations(runId)
      .pipe(Effect.orDie)) {
      const state = yield* leafExecution.poll(invocation.engineId);
      if (state._tag === "Some" && state.value._tag === "Complete") {
        continue;
      }
      const payload = yield* Schema.decodeUnknownEffect(
        leafExecution.payloadSchema
      )(JSON.parse(invocation.payloadJson)).pipe(Effect.orDie);
      // Finish a retained dispatch even if stopping won before it reached Effect.
      // The persisted fence prevents this from admitting another handler.
      yield* leafExecution.execute(payload, { discard: true });
      // Cooperative workflow interruption waits for an active Activity. These
      // leaf executions have no workflow compensations or children to orphan.
      // Immediate interruption cancels the handler and runs its Effect finalizers.
      // Terminal projection still waits for Effect's persisted completion below.
      yield* resources.interrupt(
        runId,
        invocation.engineId,
        engine.interruptUnsafe(leafExecution, invocation.engineId)
      );
      quiescent = false;
    }
    return quiescent;
  });
}

function stopWithFailure(
  runId: string,
  cause: Cause.Cause<ExecutionFailure>,
  errors: readonly Boundary[] = []
) {
  if (Cause.hasInterruptsOnly(cause)) {
    return Effect.failCause(cause);
  }
  return Effect.gen(function* () {
    const store = yield* HostStore;
    const failure = Cause.findErrorOption(cause);
    let reason =
      failure._tag === "Some"
        ? failure.value
        : hostFailure("Graph failed unexpectedly");
    if (reason.category === "Domain") {
      try {
        for (const codec of errors) {
          decode(codec, reason.detail);
        }
      } catch {
        reason = hostFailure("Workflow error boundary validation failed");
      }
    }
    yield* store
      .fence(runId, encode(ExecutionFailure, reason))
      .pipe(Effect.orDie);
    const recorded = yield* store.fenceReason(runId).pipe(Effect.orDie);
    yield* stopInvocations(runId);
    return yield* boundary(() => decode(ExecutionFailure, recorded)).pipe(
      Effect.flatMap(Effect.fail)
    );
  });
}

function executeGraph(
  run: Run,
  graph: GraphWorkflow.Graph,
  registry: typeof Application.Registry.Service,
  inherited: GraphEnvironment,
  initial: ReadonlyMap<string, unknown> = new Map()
): RuntimeEffect {
  return Effect.gen(function* () {
    inherited.budget.count += graph.nodes.length;
    if (inherited.budget.count > 10_000) {
      return yield* hostFailure("Run expansion exceeds 10000 nodes");
    }
    const values = new Map(initial);
    const state: ScopeValues = {
      nodes: new Map(graph.nodes.map((node) => [node.id, node])),
      path: inherited.path,
      registrations: new Set(
        graph.nodes
          .filter((node) => node.kind === "SignalRegistration")
          .map((node) => node.id)
      ),
      values,
    };
    const scopes = new Map([
      ...inherited.scopes,
      [graph.scope, state] as const,
    ]);
    const environment = { ...inherited, scopes };
    yield* Effect.forEach(
      graph.nodes,
      (node) =>
        Effect.gen(function* () {
          const nodeId = invocationPath(environment, node.id);
          const value = yield* DurableDeferred.raceAll({
            effects: [
              Effect.gen(function* () {
                // Start sibling durable scopes before any cached await can
                // synchronously suspend this branch on replay.
                yield* Effect.yieldNow;
                yield* awaitDependencies(node, environment);
                const result = yield* executeNode(
                  run,
                  node,
                  environment,
                  registry
                );
                return yield* boundary(() =>
                  node.kind === "Sleep" ? null : encode(nodeCodec(node), result)
                );
              }).pipe(
                Effect.catchCause((cause) =>
                  stopWithFailure(run.runId, cause, environment.errors)
                )
              ),
            ],
            error: ExecutionFailure,
            name: nodeResultName(nodeId),
            success: Schema.Json,
          });
          values.set(
            node.id,
            node.kind === "Sleep"
              ? undefined
              : yield* boundary(() => decode(nodeCodec(node), value))
          );
        }),
      { concurrency: "unbounded", discard: true }
    );
    yield* awaitReferences(Ref.references(graph.result), environment);
    return yield* boundary(() => resolve(graph.result, environment));
  });
}

function executeBranch(
  run: Run,
  node: GraphWorkflow.BranchNode,
  environment: GraphEnvironment,
  registry: typeof Application.Registry.Service
): RuntimeEffect {
  return Effect.gen(function* () {
    const choice = yield* Activity.make({
      error: ExecutionFailure,
      execute: boundary(() =>
        Schema.decodeUnknownSync(Schema.Boolean)(
          resolve(node.condition, environment)
        )
      ),
      interruptRetryPolicy: Schedule.recurs(0),
      name: `branch/${invocationPath(environment, node.id)}`,
      success: Schema.Boolean,
    });
    const graph = choice ? node.onTrue : node.onFalse;
    const result = yield* executeGraph(run, graph, registry, {
      ...environment,
      path: [...environment.path, node.id, String(choice)],
    });
    return yield* boundary(() =>
      decode(node.success, encode(node.success, result))
    );
  });
}

function executeItems(
  run: Run,
  node: GraphWorkflow.ForEachNode,
  environment: GraphEnvironment,
  registry: typeof Application.Registry.Service
): RuntimeEffect {
  return Effect.gen(function* () {
    const items = yield* Activity.make({
      error: ExecutionFailure,
      execute: boundary(() => {
        const values = resolve(node.items, environment);
        if (!Array.isArray(values) || values.length > node.maxItems) {
          throw new Error("Item limit exceeded");
        }
        const seen = new Set<string>();
        return values.map((value) => {
          const encoded = encode(node.item, value);
          const key = node.key(decode(node.item, encoded));
          if (
            typeof key !== "string" ||
            key.length === 0 ||
            key.length > 200 ||
            seen.has(key)
          ) {
            throw new Error(
              "Item keys must be unique nonempty bounded strings"
            );
          }
          seen.add(key);
          return { key, value: encoded };
        });
      }),
      interruptRetryPolicy: Schedule.recurs(0),
      name: `items/${invocationPath(environment, node.id)}`,
      success: Schema.Array(
        Schema.Struct({ key: Schema.String, value: Schema.Json })
      ),
    });
    return yield* Effect.forEach(
      items,
      (item) =>
        Effect.gen(function* () {
          const value = yield* boundary(() => decode(node.item, item.value));
          const result = yield* executeGraph(
            run,
            node.graph,
            registry,
            { ...environment, path: [...environment.path, node.id, item.key] },
            new Map([["$item", value]])
          );
          return yield* boundary(() =>
            decode(node.success, encode(node.success, result))
          );
        }),
      { concurrency: node.concurrency }
    );
  });
}

function applyDeadline(
  run: Run,
  name: string,
  duration: string | undefined,
  codec: Boundary,
  body: RuntimeEffect
): RuntimeEffect {
  if (duration === undefined) {
    return body;
  }
  return withDeadline(
    run.runId,
    name,
    duration,
    body.pipe(Effect.flatMap((value) => boundary(() => encode(codec, value)))),
    (deadline) =>
      stopWithFailure(
        run.runId,
        Cause.fail(
          new ExecutionFailure({
            category: "Control",
            detail: { deadline, name },
            outcome: "TimedOut",
          })
        )
      )
  ).pipe(Effect.flatMap((value) => boundary(() => decode(codec, value))));
}

function childTimeout(node: GraphWorkflow.ChildNode): string | undefined {
  const durations = [
    node.options.timeout,
    node.workflow.spec.execution?.timeout,
  ].filter((duration) => duration !== undefined);
  return durations.length === 0
    ? undefined
    : `${Math.min(...durations.map((duration) => durationMillis(duration)))} millis`;
}

function executeChild(
  run: Run,
  node: GraphWorkflow.ChildNode,
  environment: GraphEnvironment,
  registry: typeof Application.Registry.Service
): RuntimeEffect {
  return Effect.gen(function* () {
    const child = registry.workflows.get(node.workflow.id);
    if (!child) {
      return yield* hostFailure("Child workflow is unavailable");
    }
    const childPath = [...environment.path, node.id];
    const input = yield* boundary(() =>
      decode(
        child.definition.inputSchema,
        encode(child.definition.inputSchema, resolve(node.input, environment))
      )
    );
    const childPermit = {
      concurrency: child.definition.spec.execution?.concurrency ?? 16,
      path: JSON.stringify(childPath),
    };
    const result = yield* applyDeadline(
      run,
      `workflow/${JSON.stringify(childPath)}`,
      childTimeout(node),
      child.definition.successSchema,
      executeGraph(
        run,
        child.graph,
        registry,
        {
          ...environment,
          errors: [...environment.errors, child.definition.errorSchema],
          path: childPath,
          permits: [...environment.permits, childPermit],
          scopes: new Map(),
        },
        new Map([["$input", input]])
      )
    );
    return yield* boundary(() =>
      decode(
        child.definition.successSchema,
        encode(child.definition.successSchema, result)
      )
    );
  });
}

function executeNode(
  run: Run,
  node: GraphWorkflow.Node,
  environment: GraphEnvironment,
  registry: typeof Application.Registry.Service
): RuntimeEffect {
  const nodeId = invocationPath(environment, node.id);
  switch (node.kind) {
    case "Task": {
      const task = registry.tasks.get(node.task.id);
      if (!task) {
        return Effect.fail(hostFailure("Task provider is unavailable"));
      }
      return Effect.gen(function* () {
        const store = yield* HostStore;
        for (const ref of node.refs) {
          const scope = environment.scopes.get(ref.scope);
          if (!scope?.registrations.has(ref.nodeId)) {
            continue;
          }
          const address = yield* boundary(() =>
            decode(
              WorkflowAuthoring.SignalAddress,
              scope.values.get(ref.nodeId)
            )
          );
          const wait = yield* store
            .getWait(address.waitId)
            .pipe(
              Effect.mapError(() => hostFailure("Signal receiver unavailable"))
            );
          if (
            address.runId !== run.runId ||
            wait.runId !== run.runId ||
            wait.kind !== "signal" ||
            wait.nodeId !== JSON.stringify([...scope.path, ref.nodeId]) ||
            (wait.status !== "Open" && wait.status !== "Signaled")
          ) {
            return yield* hostFailure(
              "Signal receiver is no longer eligible for dispatch"
            );
          }
        }
        const captured = yield* Activity.make({
          error: ExecutionFailure,
          execute: boundary(() =>
            encode(task.inputSchema, resolve(node.input, environment))
          ),
          interruptRetryPolicy: Schedule.recurs(0),
          name: `input/${nodeId}`,
          success: Schema.Json,
        });
        yield* Effect.forEach(
          node.patches ?? [],
          (patch) => {
            const patchPath = [
              ...environment.path,
              node.id,
              "$patch",
              patch.id,
            ];
            return DurableDeferred.raceAll({
              effects: [
                Effect.gen(function* () {
                  // Bindings are unordered in source. Let every peer establish
                  // its held scope before an earlier binding parks on a later one.
                  yield* Effect.yieldNow;
                  for (const predecessor of patch.after) {
                    yield* DurableDeferred.await(
                      nodeResult(
                        JSON.stringify([
                          ...environment.path,
                          node.id,
                          "$patch",
                          predecessor,
                        ])
                      )
                    );
                  }
                  // Each patch gets its own decoded copy. Mutation by trusted patch
                  // code cannot change the captured wire input passed to the target.
                  const input = yield* boundary(() =>
                    decode(task.inputSchema, structuredClone(captured))
                  );
                  yield* executeGraph(
                    run,
                    patch.graph,
                    registry,
                    {
                      ...environment,
                      path: patchPath,
                      scopes: new Map(),
                    },
                    new Map([["$input", input]])
                  );
                  return null;
                }),
              ],
              error: ExecutionFailure,
              name: nodeResultName(JSON.stringify(patchPath)),
              success: Schema.Null,
            });
          },
          { concurrency: "unbounded", discard: true }
        );
        const input = yield* boundary(() =>
          decode(task.inputSchema, structuredClone(captured))
        );
        return yield* applyDeadline(
          run,
          `task/${nodeId}`,
          node.options.timeout,
          task.successSchema,
          invokeTask(run, nodeId, task, input, environment, node.options)
        );
      });
    }
    case "Map": {
      return Activity.make({
        error: ExecutionFailure,
        execute: boundary(() =>
          encode(node.success, node.compute(resolve(node.input, environment)))
        ),
        interruptRetryPolicy: Schedule.recurs(0),
        name: `map/${nodeId}`,
        success: Schema.Json,
      }).pipe(
        Effect.flatMap((value) => boundary(() => decode(node.success, value)))
      );
    }
    case "Branch": {
      return executeBranch(run, node, environment, registry);
    }
    case "ForEach": {
      return executeItems(run, node, environment, registry);
    }
    case "Workflow": {
      return executeChild(run, node, environment, registry);
    }
    case "Sleep": {
      return DurableClock.sleep({
        duration: durationMillis(node.duration, true),
        inMemoryThreshold: 0,
        name: `sleep/${nodeId}`,
      });
    }
    case "SignalRegistration": {
      return registerWait(run, node, environment).pipe(
        Effect.map((waitId) => ({ runId: run.runId, waitId }))
      );
    }
    case "AwaitSignal": {
      return Effect.gen(function* () {
        const address = yield* boundary(() =>
          decode(
            WorkflowAuthoring.SignalAddress,
            resolve(node.address, environment)
          )
        );
        const store = yield* HostStore;
        const wait = yield* store
          .getWait(address.waitId)
          .pipe(
            Effect.mapError(() => hostFailure("Signal receiver unavailable"))
          );
        if (
          address.runId !== run.runId ||
          wait.runId !== run.runId ||
          wait.kind !== "signal" ||
          wait.nodeId !== invocationPath(environment, node.address.nodeId)
        ) {
          return yield* hostFailure(
            "Signal receiver does not belong to this scope"
          );
        }
        return yield* awaitWait(run, wait.nodeId, wait.waitId, node.schema);
      });
    }
    case "Approval":
    case "Input":
    case "Signal": {
      return registerWait(run, node, environment).pipe(
        Effect.flatMap((waitId) => awaitWait(run, nodeId, waitId, node.schema))
      );
    }
    default: {
      const unreachable: never = node;
      return Effect.die(unreachable);
    }
  }
}

const graphLayer = execution.toLayer(({ runId }) =>
  Effect.gen(function* () {
    const store = yield* HostStore;
    const catalog = yield* Catalog;
    const run = yield* store
      .getRun(runId)
      .pipe(Effect.mapError(() => hostFailure("Run lookup failed")));
    const stopped = yield* store
      .fenceReason(runId)
      .pipe(
        Effect.mapError(() => hostFailure("Admission fence lookup failed"))
      );
    if (stopped !== null) {
      return yield* boundary(() => decode(ExecutionFailure, stopped)).pipe(
        Effect.flatMap(Effect.fail)
      );
    }
    const { registry } = yield* catalog
      .get(run.revision)
      .pipe(Effect.mapError(() => hostFailure("Pinned revision unavailable")));
    const environment: GraphEnvironment = {
      budget: { count: 0 },
      errors: [],
      path: [],
      permits: [
        {
          concurrency:
            run.kind === "workflow"
              ? (registry.workflows.get(run.targetId)?.definition.spec.execution
                  ?.concurrency ?? 16)
              : 1,
          path: "[]",
        },
      ],
      scopes: new Map(),
    };
    if (run.kind === "task") {
      const task = registry.tasks.get(run.targetId);
      if (!task) {
        return yield* hostFailure("Task is unavailable");
      }
      const input = yield* boundary(() => decode(task.inputSchema, run.input));
      const result = yield* invokeTask(run, "task", task, input, environment);
      return yield* boundary(() => encode(task.successSchema, result));
    }
    const workflow = registry.workflows.get(run.targetId);
    if (!workflow) {
      return yield* hostFailure("Workflow is unavailable");
    }
    const input = yield* boundary(() =>
      decode(workflow.definition.inputSchema, run.input)
    );
    const result = yield* applyDeadline(
      run,
      "workflow/[]",
      workflow.definition.spec.execution?.timeout,
      workflow.definition.successSchema,
      executeGraph(
        run,
        workflow.graph,
        registry,
        { ...environment, errors: [workflow.definition.errorSchema] },
        new Map([["$input", input]])
      )
    ).pipe(
      Effect.catch((error) => {
        if (error.category !== "Domain") {
          return Effect.fail(error);
        }
        return boundary(() =>
          decode(workflow.definition.errorSchema, error.detail)
        ).pipe(Effect.andThen(Effect.fail(error)));
      })
    );
    return yield* boundary(() =>
      encode(workflow.definition.successSchema, result)
    );
  }).pipe(Effect.catchCause((cause) => stopWithFailure(runId, cause)))
);

export const interpreterLayer = Layer.merge(graphLayer, leafLayer);

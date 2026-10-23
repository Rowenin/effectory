/* oxlint-disable max-classes-per-file -- the engine service and its error belong together. */
/**
 * The graph engine: one fiber per node, a Deferred per node, a Semaphore for
 * concurrency, and every status transition written through `State`.
 */
import { randomBytes } from "node:crypto";

import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  Schema,
  Semaphore,
} from "effect";
import type { Scope } from "effect";

import * as Json from "./json.ts";
import * as Node from "./node.ts";
import type {
  ExecContext,
  Mode,
  NodeError,
  NodeRow,
  NodeSpec,
  RunInfo,
} from "./node.ts";
import * as Output from "./output.ts";
import * as Plan from "./plan.ts";
import { State } from "./state.ts";
import type { RunRow, RunStatus, StateShape } from "./state.ts";
import type * as Workflow from "./workflow.ts";

export class RunError extends Data.TaggedError("RunError")<{
  readonly reason:
    | "not-found"
    | "revision-mismatch"
    | "not-resumable"
    | "scope-busy"
    | "invalid-input"
    | "plan-mismatch";
  readonly message: string;
  readonly runId?: string;
}> {}

export interface RunOptions {
  readonly collection: string;
  /** The collection revision; resume refuses a different one. */
  readonly revision: string;
  readonly mode?: Mode;
  readonly target?: string;
  /** Override the workflow's scope, e.g. a scratch scope for live tests. */
  readonly scope?: string;
  /** Maximum nodes executing at once. Default 8. */
  readonly concurrency?: number;
}

export interface RunSummary {
  readonly run: RunRow;
  readonly nodes: readonly NodeRow[];
}

export interface PlanResult {
  readonly built: Plan.Built;
  readonly entries: readonly Plan.PlanEntry[];
  readonly scope: string;
}

type Outcome =
  | { readonly status: "succeeded"; readonly value: unknown }
  | { readonly status: "failed"; readonly error: NodeError }
  | {
      readonly status: "skipped";
      /** An approval skipped by its own `when`: nobody needed to approve. */
      readonly bypassed?: boolean;
    }
  | { readonly status: "suspended" }
  | { readonly status: "pending" };

export interface EngineShape {
  /** Decode the input and plan the workflow without executing anything. */
  readonly plan: <I, O, R>(
    workflow: Workflow.Workflow<string, I, O, R>,
    input: unknown,
    options: RunOptions
  ) => Effect.Effect<PlanResult, RunError | Plan.PlanError, R>;
  /** Start a run and execute it until it finishes or suspends. */
  readonly run: <I, O, R>(
    workflow: Workflow.Workflow<string, I, O, R>,
    input: unknown,
    options: RunOptions
  ) => Effect.Effect<RunSummary, RunError | Plan.PlanError, R>;
  /** Continue a suspended, failed, or interrupted run. */
  readonly resume: <I, O, R>(
    workflow: Workflow.Workflow<string, I, O, R>,
    runId: string,
    options: Omit<RunOptions, "collection" | "mode" | "target">
  ) => Effect.Effect<RunSummary, RunError | Plan.PlanError, R>;
  /** Finish an unfinished run without executing more nodes. */
  readonly cancel: <I, O, R>(
    workflow: Workflow.Workflow<string, I, O, R>,
    runId: string,
    options: Omit<RunOptions, "collection" | "mode" | "target">
  ) => Effect.Effect<RunSummary, RunError | Plan.PlanError, R>;
}

export class Engine extends Context.Service<Engine, EngineShape>()(
  "effectory/Engine"
) {}

const newRunId = () =>
  `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

/** Convert anything a node failed with into a persisted error. */
export const toNodeError = (cause: Cause.Cause<unknown>): NodeError => {
  const error = Cause.squash(cause);
  if (error instanceof Node.NodeFailure) {
    return { message: error.message, tag: error.tag };
  }
  if (typeof error === "object" && error !== null) {
    const record = error as {
      _tag?: unknown;
      message?: unknown;
      name?: unknown;
    };
    let tag = "Error";
    if (typeof record._tag === "string") {
      tag = record._tag;
    } else if (typeof record.name === "string") {
      tag = record.name;
    }
    const message =
      typeof record.message === "string" && record.message.length > 0
        ? record.message
        : Cause.pretty(cause);
    return { message, tag };
  }
  return { message: String(error), tag: "Error" };
};

const encodeValue = (spec: NodeSpec, value: unknown) =>
  spec.codec
    ? Schema.encodeUnknownEffect(spec.codec)(value).pipe(
        Effect.map(Json.toJson),
        Effect.mapError(
          (issue) =>
            new Node.NodeFailure({
              message: `${spec.fqn} produced an invalid value: ${String(issue)}`,
              tag: "InvalidOutput",
            })
        )
      )
    : Effect.succeed(Json.toJson(value));

const decodeValue = (spec: NodeSpec, value: unknown) =>
  spec.codec
    ? Schema.decodeUnknownEffect(spec.codec)(value).pipe(Effect.orDie)
    : Effect.succeed(value);

const decodeInput = <I>(
  workflow: Workflow.Workflow<string, I, unknown, unknown>,
  input: unknown
) =>
  Schema.decodeUnknownEffect(Schema.toCodecJson(workflow.input))(input).pipe(
    Effect.mapError(
      (issue) =>
        new RunError({
          message: `Invalid input for ${workflow.name}: ${String(issue)}`,
          reason: "invalid-input",
        })
    )
  ) as Effect.Effect<I, RunError>;

const encodeInput = <I>(
  workflow: Workflow.Workflow<string, I, unknown, unknown>,
  input: I
) =>
  Schema.encodeUnknownEffect(Schema.toCodecJson(workflow.input))(input).pipe(
    Effect.orDie
  );

/** Run `finish` hooks of succeeded nodes in reverse order. Returns error messages. */
const finish = (
  state: StateShape,
  info: RunInfo,
  order: readonly string[],
  specs: ReadonlyMap<string, NodeSpec>,
  final: ReadonlyMap<string, Outcome>
) =>
  Effect.gen(function* finishRun() {
    const errors: string[] = [];
    for (const fqn of order.toReversed()) {
      const spec = specs.get(fqn);
      const outcome = final.get(fqn);
      // A failed Resource may have created its object before failing; clean it up too.
      const ran =
        outcome?.status === "succeeded" ||
        (outcome?.status === "failed" && spec?.kind === "resource");
      if (spec?.finish && outcome && ran) {
        const exit = yield* Effect.exit(
          spec.finish({
            ...info,
            fqn,
            state,
            value: outcome.status === "succeeded" ? outcome.value : undefined,
          })
        );
        if (Exit.isFailure(exit)) {
          const error = toNodeError(exit.cause);
          errors.push(`Cleanup of ${fqn} failed: ${error.message}`);
        }
      }
    }
    return errors;
  });

const renderReports = (
  state: StateShape,
  workflow: Workflow.Any,
  run: RunRow
) =>
  Effect.gen(function* renderAll() {
    if (workflow.reports.length === 0) {
      return;
    }
    // Every report sees the same inputs: the run's records before any report.
    const nodes = yield* state.getNodes(run.id);
    const records = yield* state.records({
      collection: run.collection,
      runId: run.id,
    });
    for (const report of workflow.reports) {
      const exit = yield* Effect.exit(
        report
          .render({ nodes, records, run })
          .pipe(Effect.provideService(State, state))
      );
      const value = Exit.isSuccess(exit)
        ? { content: exit.value, format: report.format }
        : { error: toNodeError(exit.cause).message, format: report.format };
      yield* state.putRecord({
        collection: run.collection,
        createdAt: Date.now(),
        fqn: `${run.workflow}/report/${report.name}`,
        kind: "Report",
        runId: run.id,
        scope: run.scope,
        value,
      });
    }
  });

type Gate =
  | { readonly _tag: "pending" }
  | {
      readonly _tag: "skip";
      readonly reason: string;
      readonly bypassed?: boolean;
    }
  | { readonly _tag: "fail"; readonly error: NodeError }
  | { readonly _tag: "run"; readonly input: unknown };

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Decide from upstream outcomes, `runIf`, and `when` whether a node runs. */
/**
 * Upstreams reached only through `dependsOn` order the node without feeding
 * it a value. An approval that skipped itself through its own `when` is an
 * open gate, so it does not block them. Any other skipped node still does,
 * and so do data dependencies.
 */
const orderingOnly = (spec: NodeSpec): ReadonlySet<string> => {
  const data = new Set([
    ...Output.upstreamOf(spec.input),
    ...Output.upstreamOf(spec.options.when),
  ]);
  return new Set(
    [...Output.upstreamOf(spec.options.dependsOn)].filter(
      (dep) => !data.has(dep)
    )
  );
};

const satisfied = ({ dep, outcome }: Upstream, ordering: ReadonlySet<string>) =>
  outcome.status === "succeeded" ||
  (outcome.status === "skipped" &&
    outcome.bypassed === true &&
    ordering.has(dep));

interface Upstream {
  readonly dep: string;
  readonly outcome: Outcome;
}

const gate = (
  spec: NodeSpec,
  upstream: readonly Upstream[],
  lookup: Output.Lookup
): Gate => {
  if (
    upstream.some(
      ({ outcome }) =>
        outcome.status === "suspended" || outcome.status === "pending"
    )
  ) {
    return { _tag: "pending" };
  }
  const runIf = spec.options.runIf ?? "succeeded";
  const ordering = orderingOnly(spec);
  if (
    runIf === "succeeded" &&
    !upstream.every((entry) => satisfied(entry, ordering))
  ) {
    return { _tag: "skip", reason: "an upstream node did not succeed" };
  }
  if (
    runIf === "failed" &&
    !upstream.some(({ outcome }) => outcome.status === "failed")
  ) {
    return { _tag: "skip", reason: "no upstream node failed" };
  }
  try {
    if (
      spec.options.when !== undefined &&
      Output.resolve(spec.options.when, lookup) !== true
    ) {
      return { _tag: "skip", bypassed: true, reason: "when is false" };
    }
  } catch (error) {
    return error instanceof Output.MissingValueError
      ? { _tag: "skip", reason: `condition unavailable: ${error.message}` }
      : {
          _tag: "fail",
          error: { message: messageOf(error), tag: "OutputError" },
        };
  }
  try {
    return { _tag: "run", input: Output.resolve(spec.input, lookup) };
  } catch (error) {
    return {
      _tag: "fail",
      error: {
        message: messageOf(error),
        tag:
          error instanceof Output.MissingValueError
            ? "MissingValue"
            : "OutputError",
      },
    };
  }
};

const resolveResult = (
  returned: unknown,
  lookup: Output.Lookup
):
  | { readonly _tag: "Success"; readonly success: unknown }
  | { readonly _tag: "Failure"; readonly failure: string } => {
  try {
    return {
      _tag: "Success",
      success: Json.toJson(Output.resolve(returned, lookup)),
    };
  } catch (error) {
    return { _tag: "Failure", failure: messageOf(error) };
  }
};

/** Execute a built plan. `previous` holds node rows from earlier attempts. */
const execute = (
  state: StateShape,
  workflow: Workflow.Any,
  built: Plan.Built,
  previous: ReadonlyMap<string, NodeRow>,
  concurrency: number
): Effect.Effect<RunSummary, never, Scope.Scope> =>
  Effect.gen(function* executeRun() {
    const { info } = built;
    const specs = new Map(built.specs);
    const order = [...built.order];
    const outcomes = new Map<string, Deferred.Deferred<Outcome>>();
    const final = new Map<string, Outcome>();
    const values = new Map<string, unknown>();
    const semaphore = yield* Semaphore.make(concurrency);
    const lookup: Output.Lookup = (fqn) => {
      if (!values.has(fqn)) {
        throw new Output.MissingValueError(fqn);
      }
      return values.get(fqn);
    };
    const writeNode = (
      spec: NodeSpec,
      row: Omit<NodeRow, "runId" | "fqn" | "kind" | "type" | "updatedAt">
    ) =>
      state.putNode({
        ...row,
        fqn: spec.fqn,
        kind: spec.kind,
        runId: info.runId,
        type: spec.type,
        updatedAt: Date.now(),
        ...(spec.options.allowFailure ? { allowFailure: true } : {}),
      });

    const awaitValue = <A>(value: A) =>
      Effect.gen(function* awaitUpstream() {
        for (const dep of Output.upstreamOf(value)) {
          const deferred = outcomes.get(dep);
          if (deferred === undefined) {
            return yield* new Node.NodeFailure({
              message: `Unknown node ${dep}`,
              tag: "UnknownNode",
            });
          }
          const outcome = yield* Deferred.await(deferred);
          if (outcome.status !== "succeeded") {
            return yield* new Node.NodeFailure({
              message: `${dep} ${outcome.status}`,
              tag: "UpstreamFailed",
            });
          }
        }
        return yield* Effect.try({
          catch: (error) =>
            new Node.NodeFailure({
              message: messageOf(error),
              tag: "OutputError",
            }),
          try: () => Output.resolve(value, lookup),
        });
      });

    const succeed = (
      spec: NodeSpec,
      input: unknown,
      attempt: number,
      encoded: unknown
    ) =>
      Effect.gen(function* persistSuccess() {
        if (spec.record) {
          yield* state.putRecord({
            collection: info.collection,
            createdAt: Date.now(),
            fqn: spec.fqn,
            input: Json.toJson(input),
            inputDigest: Json.digest(input),
            kind: spec.type,
            runId: info.runId,
            scope: info.scope,
            value: encoded,
          });
          if (spec.options.keep) {
            yield* state.pruneRecords({
              collection: info.collection,
              fqn: spec.fqn,
              keep: spec.options.keep,
              scope: info.scope,
            });
          }
        }
        yield* writeNode(spec, {
          attempt,
          status: "succeeded",
          value: encoded,
        });
      });

    // oxlint-disable-next-line no-use-before-define -- runNode and start recurse through expand.
    const runNode = (spec: NodeSpec): Effect.Effect<void> =>
      Effect.gen(function* runOne() {
        const deferred = outcomes.get(spec.fqn) as Deferred.Deferred<Outcome>;
        const complete = (outcome: Outcome) =>
          Effect.suspend(() => {
            final.set(spec.fqn, outcome);
            if (outcome.status === "succeeded") {
              values.set(spec.fqn, outcome.value);
            }
            return Deferred.succeed(deferred, outcome);
          });
        const prior = previous.get(spec.fqn);
        const fail = (error: NodeError, attempt: number) =>
          writeNode(spec, { attempt, error, status: "failed" }).pipe(
            Effect.andThen(complete({ error, status: "failed" }))
          );

        if (prior?.status === "succeeded" && spec.reuse === "record") {
          const value = yield* decodeValue(spec, prior.value);
          return yield* complete({ status: "succeeded", value });
        }

        const upstream = yield* Effect.forEach(
          [...Node.dependencies(spec)],
          (dep) =>
            Deferred.await(
              outcomes.get(dep) as Deferred.Deferred<Outcome>
            ).pipe(Effect.map((outcome) => ({ dep, outcome })))
        );
        const decision = gate(spec, upstream, lookup);
        const idle = prior?.attempt ?? 0;
        if (decision._tag === "pending") {
          yield* writeNode(spec, {
            attempt: idle,
            reason: "waiting on a suspended node",
            status: "pending",
          });
          return yield* complete({ status: "pending" });
        }
        if (decision._tag === "skip") {
          yield* writeNode(spec, {
            attempt: idle,
            reason: decision.reason,
            status: "skipped",
          });
          return yield* complete(
            decision.bypassed === true && spec.kind === "approve"
              ? { bypassed: true, status: "skipped" }
              : { status: "skipped" }
          );
        }
        if (decision._tag === "fail") {
          return yield* fail(decision.error, idle);
        }

        const { input } = decision;
        const attempt = idle + 1;
        const body = Effect.gen(function* executeNode() {
          yield* writeNode(spec, { attempt, status: "running" });
          const exit = yield* Effect.exit(
            Effect.suspend(() =>
              spec.execute({
                ...info,
                await: awaitValue,
                // oxlint-disable-next-line no-use-before-define -- see runNode.
                expand: expand(spec),
                fqn: spec.fqn,
                input,
                previous: prior,
                state,
              })
            )
          );
          if (Exit.isFailure(exit)) {
            return yield* fail(toNodeError(exit.cause), attempt);
          }
          const result = exit.value;
          if (result._tag === "Suspended") {
            yield* writeNode(spec, {
              attempt,
              reason: result.reason,
              status: "suspended",
            });
            return yield* complete({ status: "suspended" });
          }
          const encoded = yield* Effect.exit(encodeValue(spec, result.value));
          if (Exit.isFailure(encoded)) {
            return yield* fail(toNodeError(encoded.cause), attempt);
          }
          yield* succeed(spec, input, attempt, encoded.value);
          return yield* complete({ status: "succeeded", value: result.value });
        });
        // Take the group permit first so nodes queued on it hold no global permit.
        const permitted =
          spec.permit === false ? body : semaphore.withPermit(body);
        yield* spec.limiter ? spec.limiter.withPermit(permitted) : permitted;
      });

    const start = (spec: NodeSpec) =>
      Effect.gen(function* startNode() {
        outcomes.set(spec.fqn, yield* Deferred.make<Outcome>());
        specs.set(spec.fqn, spec);
        yield* Effect.forkScoped(runNode(spec));
      });

    const expand =
      (parent: NodeSpec): ExecContext["expand"] =>
      (body, options) =>
        Effect.gen(function* expandNode() {
          const path = [
            ...parent.fqn.split("/"),
            ...(options?.namespace ? [options.namespace] : []),
          ];
          let scoped = Effect.provideService(body, Node.Namespace, path);
          if (options?.context) {
            // The plan-time Registry and namespace must not leak into children.
            scoped = Effect.provideContext(
              scoped,
              Context.omit(
                Node.Registry,
                Node.Namespace,
                Node.Defaults,
                Node.Limiter
              )(options.context) as Context.Context<never>
            );
          }
          const collected = yield* Plan.collect(
            info,
            scoped,
            new Set(outcomes.keys())
          ).pipe(
            Effect.mapError((error) =>
              error instanceof Plan.PlanError
                ? new Node.NodeFailure({
                    message: error.message,
                    tag: "PlanError",
                  })
                : error
            )
          );
          for (const spec of collected.specs) {
            order.push(spec.fqn);
            yield* start(spec);
          }
          return collected.value;
        }) as never;

    for (const fqn of built.order) {
      outcomes.set(fqn, yield* Deferred.make<Outcome>());
    }
    for (const fqn of built.order) {
      yield* Effect.forkScoped(runNode(specs.get(fqn) as NodeSpec));
    }
    // Dynamic nodes join `outcomes` while we wait; loop until it is stable.
    let awaited = -1;
    while (awaited !== outcomes.size) {
      awaited = outcomes.size;
      yield* Effect.forEach([...outcomes.values()], Deferred.await, {
        discard: true,
      });
    }

    const results = [...final.entries()];
    const blocked = results.some(
      ([, outcome]) =>
        outcome.status === "suspended" || outcome.status === "pending"
    );
    const failed = results.some(
      ([fqn, outcome]) =>
        outcome.status === "failed" && !specs.get(fqn)?.options.allowFailure
    );
    let status: RunStatus = "succeeded";
    if (blocked) {
      status = "suspended";
    } else if (failed) {
      status = "failed";
    }

    const errors: string[] = [];
    let result: unknown;
    if (status !== "suspended") {
      errors.push(...(yield* finish(state, info, order, specs, final)));
      if (status === "succeeded") {
        const resolved = resolveResult(built.returned, lookup);
        if (resolved._tag === "Success") {
          result = resolved.success;
        } else {
          status = "failed";
          errors.push(`Workflow result: ${resolved.failure}`);
        }
      }
    }
    let row = yield* state.updateRun(info.runId, {
      status,
      ...(result === undefined ? {} : { result }),
      ...(errors.length > 0 ? { error: errors.join("\n") } : {}),
    });
    if (status !== "suspended") {
      yield* renderReports(state, workflow, row);
      row = (yield* state.getRun(info.runId)) ?? row;
    }
    return { nodes: yield* state.getNodes(info.runId), run: row };
  });

/** The default engine over `State`. */
export const make = Effect.gen(function* makeEngine() {
  const state = yield* State;

  const prepare = <I, O, R>(
    workflow: Workflow.Workflow<string, I, O, R>,
    input: I,
    info: RunInfo
  ) =>
    Plan.build(workflow, input, info).pipe(
      Effect.provideService(State, state)
    ) as Effect.Effect<Plan.Built, Plan.PlanError, R>;

  const plan: EngineShape["plan"] = (workflow, raw, options) =>
    Effect.gen(function* planRun() {
      const input = yield* decodeInput(workflow, raw);
      const scope = options.scope ?? workflow.scope(input);
      const built = yield* prepare(workflow, input, {
        collection: options.collection,
        mode: options.mode ?? "live",
        runId: "plan",
        scope,
        workflow: workflow.name,
      });
      const entries = yield* Plan.describe(built, state);
      return { built, entries, scope };
    });

  const run: EngineShape["run"] = (workflow, raw, options) =>
    Effect.gen(function* startRun() {
      const input = yield* decodeInput(workflow, raw);
      const scope = options.scope ?? workflow.scope(input);
      const runId = newRunId();
      const info: RunInfo = {
        collection: options.collection,
        mode: options.mode ?? "live",
        runId,
        scope,
        workflow: workflow.name,
      };
      const built = yield* prepare(workflow, input, info);
      const now = Date.now();
      const admission = yield* state.admitRun({
        collection: options.collection,
        createdAt: now,
        id: runId,
        input: Json.toJson(yield* encodeInput(workflow, input)),
        mode: info.mode,
        plan: Plan.snapshot(built.graph),
        revision: options.revision,
        scope,
        status: "running",
        updatedAt: now,
        workflow: workflow.name,
        ...(options.target === undefined ? {} : { target: options.target }),
      });
      if (!admission.admitted) {
        return yield* new RunError({
          message: `Run ${admission.run.id} of ${workflow.name} is ${admission.run.status} for scope ${scope}; resume or cancel it first`,
          reason: "scope-busy",
          runId: admission.run.id,
        });
      }
      return yield* Effect.scoped(
        execute(
          state,
          workflow as Workflow.Any,
          built,
          new Map(),
          options.concurrency ?? 8
        )
      );
    });

  const reopen = <I, O, R>(
    workflow: Workflow.Workflow<string, I, O, R>,
    runId: string,
    revision: string
  ) =>
    Effect.gen(function* reopenRun() {
      const existing = yield* state.getRun(runId);
      if (existing === undefined || existing.workflow !== workflow.name) {
        return yield* new RunError({
          message: `Unknown run ${runId} of ${workflow.name}`,
          reason: "not-found",
          runId,
        });
      }
      if (!["running", "suspended", "failed"].includes(existing.status)) {
        return yield* new RunError({
          message: `Run ${runId} is ${existing.status}`,
          reason: "not-resumable",
          runId,
        });
      }
      if (existing.revision !== revision) {
        return yield* new RunError({
          message: `Run ${runId} started at revision ${existing.revision.slice(0, 12)}; the collection is now at ${revision.slice(0, 12)}. Restore that source or start a new run.`,
          reason: "revision-mismatch",
          runId,
        });
      }
      const input = yield* decodeInput(workflow, existing.input);
      const built = yield* prepare(workflow, input, {
        collection: existing.collection,
        mode: existing.mode,
        runId,
        scope: existing.scope,
        workflow: workflow.name,
      });
      const recorded = Plan.snapshotNodes(existing.plan).toSorted();
      const current = [...built.order].toSorted();
      if (recorded.join("\n") !== current.join("\n")) {
        return yield* new RunError({
          message: `Run ${runId}'s plan differs from the plan its workflow builds now`,
          reason: "plan-mismatch",
          runId,
        });
      }
      return { built, existing };
    });

  const resume: EngineShape["resume"] = (workflow, runId, options) =>
    Effect.gen(function* resumeRun() {
      const { built } = yield* reopen(workflow, runId, options.revision);
      const previous = new Map(
        (yield* state.getNodes(runId)).map((row) => [row.fqn, row])
      );
      yield* state.updateRun(runId, { status: "running" });
      return yield* Effect.scoped(
        execute(
          state,
          workflow as Workflow.Any,
          built,
          previous,
          options.concurrency ?? 8
        )
      );
    });

  const cancel: EngineShape["cancel"] = (workflow, runId, options) =>
    Effect.gen(function* cancelRun() {
      const { built } = yield* reopen(workflow, runId, options.revision);
      const rows = yield* state.getNodes(runId);
      const final = new Map<string, Outcome>();
      const specs = new Map(built.specs);
      for (const row of rows) {
        const spec = specs.get(row.fqn);
        if (spec && row.status === "succeeded") {
          final.set(row.fqn, {
            status: "succeeded",
            value: yield* decodeValue(spec, row.value),
          });
        }
      }
      const errors = yield* finish(
        state,
        built.info,
        built.order,
        specs,
        final
      );
      for (const approval of yield* state.listApprovals({
        runId,
        status: "pending",
      })) {
        yield* state.putApproval({
          ...approval,
          decidedAt: Date.now(),
          note: "run cancelled",
          status: "rejected",
        });
      }
      const cancelled = yield* state.updateRun(runId, {
        status: "cancelled",
        ...(errors.length > 0 ? { error: errors.join("\n") } : {}),
      });
      return { nodes: yield* state.getNodes(runId), run: cancelled };
    });

  return Engine.of({ cancel, plan, resume, run });
});

/** The default engine. */
export const layer: Layer.Layer<Engine, never, State> = Layer.effect(
  Engine,
  make
);

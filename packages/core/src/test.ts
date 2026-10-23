/* oxlint-disable max-classes-per-file -- the Test harness errors live with it. */
/**
 * The test harness: run a whole workflow against fakes (or live in a scratch
 * scope that is cleaned up), and exercise a provider's lifecycle through the
 * real engine.
 */
import { randomBytes } from "node:crypto";

import { Cause, Data, Effect, Layer, Schema } from "effect";

import * as Engine from "./engine.ts";
import type { Mode, NodeRow } from "./node.ts";
import type { PlanError } from "./plan.ts";
import * as Provider from "./provider.ts";
import * as Resource from "./resource.ts";
import * as States from "./state.ts";
import { State } from "./state.ts";
import type { RecordRow, ResourceRow, RunRow, StateShape } from "./state.ts";
import * as Workflow from "./workflow.ts";

/** Live-mode cleanup could not delete every resource in the scratch scope. */
export class TestCleanupFailed extends Data.TaggedError("TestCleanupFailed")<{
  readonly message: string;
  readonly scope: string;
}> {}

/** A provider violated an expectation of `Test.provider`. */
export class ProviderTestFailed extends Data.TaggedError("ProviderTestFailed")<{
  readonly message: string;
  readonly step: string;
  readonly report: ProviderReport;
}> {}

/** The value of an `AssertResult` record. */
export interface AssertRecord {
  readonly passed: boolean;
  readonly message: string;
  readonly severity: string;
}

export interface RunResult {
  readonly run: RunRow;
  readonly nodes: readonly NodeRow[];
  /** Records written by the run, oldest first. */
  readonly records: readonly RecordRow[];
  readonly asserts: readonly AssertRecord[];
  /** Resource rows left in the run's scope (after cleanup in live mode). */
  readonly resources: readonly ResourceRow[];
}

export interface RunOptions {
  /** Default `fake`. `live` runs in a scratch scope and deletes its resources afterwards. */
  readonly mode?: Mode;
  /** Default `test`. */
  readonly collection?: string;
  readonly concurrency?: number;
}

const engineLayer = Engine.layer.pipe(Layer.provideMerge(States.memory));

const cleanupScope = (
  state: StateShape,
  collection: string,
  scope: string,
  failures: string[]
) =>
  Effect.gen(function* cleanup() {
    const rows = yield* state.listResources({ collection, scope });
    for (const row of rows.toReversed()) {
      yield* Resource.destroy({
        collection,
        fqn: row.fqn,
        mode: "live",
        scope,
      }).pipe(
        Effect.provideService(State, state),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            failures.push(`${row.fqn}: ${Cause.pretty(cause)}`);
          })
        )
      );
    }
  });

/**
 * Run `workflow` on a fresh in-memory State. Providers and services come from
 * the caller (`Effect.provide`).
 *
 * ```ts
 * const result = yield* Test.run(verifyPr, { repo, pr: 12 }).pipe(Effect.provide(fakes));
 * expect(result.asserts.every((a) => a.passed)).toBe(true);
 * ```
 */
export const run = <I, O, R>(
  workflow: Workflow.Workflow<string, I, O, R>,
  input: I,
  options: RunOptions = {}
): Effect.Effect<
  RunResult,
  Engine.RunError | TestCleanupFailed | PlanError,
  R
> =>
  Effect.gen(function* testRun() {
    const engine = yield* Engine.Engine;
    const state = yield* State;
    const mode = options.mode ?? "fake";
    const collection = options.collection ?? "test";
    const encoded = yield* Schema.encodeUnknownEffect(
      Schema.toCodecJson(workflow.input)
    )(input).pipe(
      Effect.mapError(
        (issue) =>
          new Engine.RunError({
            message: `Invalid input for ${workflow.name}: ${String(issue)}`,
            reason: "invalid-input",
          })
      )
    );
    const scratch =
      mode === "live" ? `test-${randomBytes(6).toString("hex")}` : undefined;
    const failures: string[] = [];
    const summary = yield* engine
      .run(workflow, encoded, {
        collection,
        mode,
        revision: "test",
        ...(scratch === undefined ? {} : { scope: scratch }),
        ...(options.concurrency === undefined
          ? {}
          : { concurrency: options.concurrency }),
      })
      .pipe(
        Effect.ensuring(
          scratch === undefined
            ? Effect.void
            : cleanupScope(state, collection, scratch, failures)
        )
      );
    if (scratch !== undefined && failures.length > 0) {
      return yield* new TestCleanupFailed({
        message: `Could not delete every resource in ${scratch}:\n${failures.join("\n")}`,
        scope: scratch,
      });
    }
    const records = (yield* state.records({
      collection,
      runId: summary.run.id,
    })).toReversed();
    return {
      asserts: records
        .filter((record) => record.kind === "AssertResult")
        .map((record) => record.value as AssertRecord),
      nodes: summary.nodes,
      records,
      resources: yield* state.listResources({
        collection,
        scope: summary.run.scope,
      }),
      run: summary.run,
    };
  }).pipe(Effect.provide(engineLayer));

export interface ProviderCases<P> {
  readonly create: P;
  /** Props that `diff` classifies as an update. */
  readonly update?: P;
  /** Props that `diff` classifies as a replacement. */
  readonly replace?: P;
}

export interface ProviderStep {
  readonly name: string;
  readonly detail: string;
}

export interface ProviderReport {
  readonly type: string;
  /** Steps that passed, in order. */
  readonly steps: readonly ProviderStep[];
}

interface Call {
  readonly method: "read" | "diff" | "reconcile" | "delete";
  readonly input: unknown;
  readonly result?: unknown;
}

/** Record every lifecycle call, so steps can assert on what the engine did. */
const instrument = <P, A>(
  service: Provider.ProviderService<P, A>,
  calls: Call[]
): Provider.ProviderService<P, A> => {
  const { diff } = service;
  return {
    ...service,
    delete: (input) =>
      service
        .delete(input)
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => calls.push({ input, method: "delete" }))
          )
        ),
    read: (input) =>
      service
        .read(input)
        .pipe(
          Effect.tap((result) =>
            Effect.sync(() => calls.push({ input, method: "read", result }))
          )
        ),
    reconcile: (input) =>
      service
        .reconcile(input)
        .pipe(
          Effect.tap((result) =>
            Effect.sync(() =>
              calls.push({ input, method: "reconcile", result })
            )
          )
        ),
    ...(diff === undefined
      ? {}
      : {
          diff: (input) =>
            diff(input).pipe(
              Effect.tap((result) =>
                Effect.sync(() => calls.push({ input, method: "diff", result }))
              )
            ),
        }),
  };
};

const subjectName = "subject";
const testWorkflow = "provider-test";
const testScope = "provider-test";
const testCollection = "provider-test";
const fqn = `${testWorkflow}/${subjectName}`;
const key = { collection: testCollection, fqn, scope: testScope };

/**
 * Exercise a provider through the real engine: create, rerun (noop), update,
 * replace, delete, and recovery from a reconcile interrupted before its
 * terminal state row was written. Fails with `ProviderTestFailed` on the
 * first violated expectation.
 *
 * ```ts
 * yield* Test.provider(Comment, { layer: CommentProvider, cases: { create, update, replace } });
 * ```
 */
export const provider = <Type extends string, P, A, E, R>(
  resource: Resource.Resource<Type, P, A>,
  options: {
    readonly layer: Layer.Layer<Provider.Provider<Type>, E, R>;
    readonly mode?: Mode;
    readonly cases: ProviderCases<P>;
  }
): Effect.Effect<ProviderReport, ProviderTestFailed | E, R> =>
  Effect.gen(function* testProvider() {
    const mode = options.mode ?? "fake";
    const providerTag = Provider.tag<Type, P, A>(resource.type);
    const original = yield* providerTag;
    const calls: Call[] = [];
    const service = instrument(Provider.forMode(original, mode), calls);
    const shape = { ...original, [mode]: service };
    const engine = yield* Engine.Engine;
    const state = yield* State;
    const steps: ProviderStep[] = [];
    const report = (): ProviderReport => ({
      steps: [...steps],
      type: resource.type,
    });
    const fail = (step: string, message: string) =>
      new ProviderTestFailed({
        message: `${resource.type} ${step}: ${message}`,
        report: report(),
        step,
      });
    const callsOf = (method: Call["method"]) =>
      calls.filter((call) => call.method === method);
    const guard = <X, RX>(
      step: string,
      effect: Effect.Effect<X, unknown, RX>
    ) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.fail(fail(step, `failed: ${Cause.pretty(cause)}`))
        )
      );

    const runWith = (step: string, props: P) =>
      Effect.gen(function* runStep() {
        calls.length = 0;
        const workflow = Workflow.make(
          testWorkflow,
          { description: `Test ${resource.type}`, input: Schema.Struct({}) },
          () => resource(subjectName, props as never)
        );
        const summary = yield* guard(
          step,
          engine.run(
            workflow,
            {},
            {
              collection: testCollection,
              mode,
              revision: "test",
              scope: testScope,
            }
          )
        );
        const node = summary.nodes.find((row) => row.fqn === fqn);
        if (summary.run.status !== "succeeded") {
          return yield* fail(
            step,
            `the run ${summary.run.status}: ${node?.error?.tag ?? ""} ${node?.error?.message ?? summary.run.error ?? ""}`
          );
        }
        const row = yield* state.getResource(key);
        if (row === undefined) {
          return yield* fail(step, "no state row was written");
        }
        const attributes = yield* Schema.decodeUnknownEffect(
          Schema.toCodecJson(resource.attributes)
        )(row.attributes).pipe(Effect.orDie);
        return { attributes: attributes as A, row };
      });

    const expectStatus = (step: string, row: ResourceRow, status: string) =>
      row.status === status
        ? Effect.void
        : Effect.fail(
            fail(step, `expected state ${status}, got ${row.status}`)
          );

    const expectReadable = (
      step: string,
      olds: P,
      output: A,
      present: boolean
    ) =>
      Effect.gen(function* readBack() {
        const found = yield* guard(
          step,
          service.read({ fqn, olds, output, scope: key.scope })
        );
        if (present && found === undefined) {
          return yield* fail(
            step,
            "read does not find the object reconcile returned"
          );
        }
        if (!present && found !== undefined) {
          return yield* fail(step, "read still finds a deleted object");
        }
      });

    const body = Effect.gen(function* steps_() {
      // create
      const created = yield* runWith("create", options.cases.create);
      yield* expectStatus("create", created.row, "created");
      if (callsOf("reconcile").length !== 1) {
        return yield* fail(
          "create",
          `expected 1 reconcile, got ${callsOf("reconcile").length}`
        );
      }
      yield* expectReadable(
        "create",
        options.cases.create,
        created.attributes,
        true
      );
      steps.push({ detail: "reconciled once; read finds it", name: "create" });

      // rerun with the same props
      const again = yield* runWith("noop", options.cases.create);
      if (callsOf("reconcile").length > 0 || callsOf("delete").length > 0) {
        return yield* fail(
          "noop",
          "rerunning with the same props reconciled or deleted; diff must report noop"
        );
      }
      steps.push({ detail: "same props: no reconcile", name: "noop" });

      let olds = options.cases.create;
      let current = again.attributes;
      if (options.cases.update !== undefined) {
        const updated = yield* runWith("update", options.cases.update);
        yield* expectStatus("update", updated.row, "updated");
        const [reconciled] = callsOf("reconcile");
        if (
          callsOf("delete").length > 0 ||
          (reconciled?.input as Provider.ReconcileInput<P, A> | undefined)
            ?.output === undefined
        ) {
          return yield* fail(
            "update",
            "an update must reconcile the existing object, not create or delete"
          );
        }
        yield* expectReadable(
          "update",
          options.cases.update,
          updated.attributes,
          true
        );
        for (const stable of original.live.stables ?? []) {
          if (
            JSON.stringify(updated.attributes[stable]) !==
            JSON.stringify(current[stable])
          ) {
            return yield* fail(
              "update",
              `stable attribute ${String(stable)} changed`
            );
          }
        }
        steps.push({
          detail: "reconciled in place; stables kept",
          name: "update",
        });
        olds = options.cases.update;
        current = updated.attributes;
      }

      if (options.cases.replace !== undefined) {
        const replaced = yield* runWith("replace", options.cases.replace);
        yield* expectStatus("replace", replaced.row, "replaced");
        if (callsOf("delete").length !== 1) {
          return yield* fail(
            "replace",
            `expected the old object deleted once, got ${callsOf("delete").length}`
          );
        }
        yield* expectReadable("replace", olds, current, false);
        yield* expectReadable(
          "replace",
          options.cases.replace,
          replaced.attributes,
          true
        );
        steps.push({
          detail: "new object created; old one deleted",
          name: "replace",
        });
        olds = options.cases.replace;
        current = replaced.attributes;
      }

      // delete
      calls.length = 0;
      yield* guard(
        "delete",
        Resource.destroy({ ...key, mode }).pipe(
          Effect.provideService(providerTag, shape),
          Effect.provideService(State, state)
        )
      );
      if ((yield* state.getResource(key)) !== undefined) {
        return yield* fail("delete", "the state row is still present");
      }
      yield* expectReadable("delete", olds, current, false);
      yield* guard(
        "delete",
        service.delete({ fqn, olds, output: current, scope: key.scope })
      );
      steps.push({
        detail: "deleted; a second delete is a noop",
        name: "delete",
      });

      // a reconcile interrupted after it created the object, before the terminal row
      yield* state.putResource({
        ...key,
        lifetime: "scope",
        mode,
        props: yield* Schema.encodeUnknownEffect(
          Schema.toCodecJson(resource.props)
        )(options.cases.create).pipe(Effect.orDie),
        runId: "interrupted",
        status: "creating",
        type: resource.type,
        updatedAt: Date.now(),
      });
      const orphan = yield* guard(
        "recover",
        service.reconcile({
          fqn,
          news: options.cases.create,
          olds: undefined,
          output: undefined,
          scope: key.scope,
        })
      );
      const recovered = yield* runWith("recover", options.cases.create);
      const creates = callsOf("reconcile").filter(
        (call) =>
          (call.input as Provider.ReconcileInput<P, A>).output === undefined
      );
      if (creates.length > 0) {
        return yield* fail(
          "recover",
          "read did not find the object an interrupted reconcile created, so the resumed run created a duplicate"
        );
      }
      yield* expectStatus("recover", recovered.row, "updated");
      yield* expectReadable(
        "recover",
        options.cases.create,
        recovered.attributes,
        true
      );
      for (const stable of original.live.stables ?? []) {
        if (
          JSON.stringify(recovered.attributes[stable]) !==
          JSON.stringify(orphan[stable])
        ) {
          return yield* fail(
            "recover",
            `stable attribute ${String(stable)} changed`
          );
        }
      }
      steps.push({
        detail: "read found the object; no duplicate",
        name: "recover",
      });

      yield* guard(
        "cleanup",
        Resource.destroy({ ...key, mode }).pipe(
          Effect.provideService(providerTag, shape),
          Effect.provideService(State, state)
        )
      );
      return report();
    });

    return yield* body.pipe(Effect.provideService(providerTag, shape));
  }).pipe(Effect.provide(Layer.merge(engineLayer, options.layer)));

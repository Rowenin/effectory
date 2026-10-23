import { describe, expect, test } from "bun:test";

import { Context, Effect, Layer, Schema } from "effect";

import * as Engine from "../src/engine.ts";
import * as Provider from "../src/provider.ts";
import * as Resource from "../src/resource.ts";
import * as State from "../src/state.ts";
import * as Workflow from "../src/workflow.ts";

const options = { collection: "test", revision: "r1" };
const engineLayer = Engine.layer.pipe(Layer.provideMerge(State.memory));

const Box = Resource.make("Test.Box", {
  attributes: Schema.Struct({ id: Schema.String, label: Schema.String }),
  description: "A labelled box",
  props: Schema.Struct({ label: Schema.String, size: Schema.Int }),
});
type BoxProps = (typeof Box.props)["Type"];

const boxAttributes = (props: BoxProps, fqn: string) => ({
  id: `${fqn}:${props.size}`,
  label: props.label,
});

const memoryBox = (
  extra: Partial<
    Provider.MemoryOptions<BoxProps, (typeof Box.attributes)["Type"]>
  > = {}
) => Provider.memory(Box, { attributes: boxAttributes, ...extra });

/** A workflow with one Box whose props come from the input. */
const boxWorkflow = (
  wrap: <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> = (
    self
  ) => self,
  boxOptions: Resource.ResourceOptions = {}
) =>
  Workflow.make(
    "boxes",
    {
      description: "",
      input: Schema.Struct({ label: Schema.String, size: Schema.Int }),
      scope: () => "shelf",
    },
    (props) =>
      wrap(Box("box", props, boxOptions)).pipe(
        Effect.map((box) => ({ id: box.id }))
      )
  );

const run = <A, E>(
  provider: Layer.Layer<Provider.Provider<"Test.Box">>,
  effect: Effect.Effect<
    A,
    E,
    Engine.Engine | State.State | Provider.Provider<"Test.Box">
  >
) =>
  Effect.runPromise(Effect.provide(effect, Layer.merge(engineLayer, provider)));

const runBox = (
  workflow: Workflow.Workflow<
    "boxes",
    // oxlint-disable-next-line typescript/no-explicit-any -- tests run workflows with different inputs.
    any,
    unknown,
    Provider.Provider<"Test.Box">
  >,
  props: unknown,
  mode: "live" | "fake" = "live"
) =>
  Effect.flatMap(Engine.Engine, (engine) =>
    engine.run(workflow, props, { ...options, mode })
  );

const key = { collection: "test", fqn: "boxes/box", scope: "shelf" };
const getRow = Effect.flatMap(State.State, (state) => state.getResource(key));
const errorOf = (summary: Engine.RunSummary) =>
  summary.nodes.find((node) => node.fqn === "boxes/box")?.error;

describe("Resource", () => {
  test("creates, records, and noops on the same props", async () => {
    const box = memoryBox();
    const workflow = boxWorkflow();
    const result = await run(
      Provider.succeed(Box, box),
      Effect.gen(function* createThenNoop() {
        const first = yield* runBox(workflow, { label: "a", size: 1 });
        const row = yield* getRow;
        const second = yield* runBox(workflow, { label: "a", size: 1 });
        const state = yield* State.State;
        const records = yield* state.records({ collection: "test" });
        return { first, records, row, second };
      })
    );
    expect(result.first.run.status).toBe("succeeded");
    expect(result.first.run.result).toEqual({ id: "boxes/box:1" });
    expect(result.row?.status).toBe("created");
    expect(result.row?.attributes).toEqual({ id: "boxes/box:1", label: "a" });
    expect(result.row?.type).toBe("Test.Box");
    expect(result.row?.lifetime).toBe("scope");
    expect(result.row?.mode).toBe("live");
    expect(result.second.run.status).toBe("succeeded");
    expect(box.store.calls.creates).toBe(1);
    expect(box.store.calls.updates).toBe(0);
    expect(result.records.map((record) => record.value)).toEqual([
      { id: "boxes/box:1", label: "a" },
      { id: "boxes/box:1", label: "a" },
    ]);
  });

  test("updates on changed props", async () => {
    const box = memoryBox();
    const workflow = boxWorkflow();
    const row = await run(
      Provider.succeed(Box, box),
      Effect.gen(function* update() {
        yield* runBox(workflow, { label: "a", size: 1 });
        yield* runBox(workflow, { label: "b", size: 1 });
        return yield* getRow;
      })
    );
    expect(row?.status).toBe("updated");
    expect(row?.props).toEqual({ label: "b", size: 1 });
    expect(box.store.calls).toMatchObject({ creates: 1, updates: 1 });
    expect(box.store.all()).toHaveLength(1);
  });

  for (const deleteFirst of [false, true]) {
    test(`replaces when diff says so (deleteFirst: ${deleteFirst})`, async () => {
      const order: string[] = [];
      const box = memoryBox({
        diff: ({ news, olds }) =>
          Effect.succeed(
            news.size === olds.size
              ? undefined
              : { action: "replace", deleteFirst }
          ),
        onDelete: () => Effect.sync(() => order.push("delete")),
        onReconcile: () => Effect.sync(() => order.push("reconcile")),
      });
      const workflow = boxWorkflow();
      const row = await run(
        Provider.succeed(Box, box),
        Effect.gen(function* replace() {
          yield* runBox(workflow, { label: "a", size: 1 });
          yield* runBox(workflow, { label: "a", size: 2 });
          return yield* getRow;
        })
      );
      expect(row?.status).toBe("replaced");
      expect(row?.previous).toBeUndefined();
      expect(row?.attributes).toEqual({ id: "boxes/box:2", label: "a" });
      expect(box.store.all().map((entry) => entry.attributes.id)).toEqual([
        "boxes/box:2",
      ]);
      expect(order).toEqual(
        deleteFirst
          ? ["reconcile", "delete", "reconcile"]
          : ["reconcile", "reconcile", "delete"]
      );
    });
  }

  test("fails on an unowned object unless adopted", async () => {
    const box = memoryBox();
    box.store.seed("boxes/box", { label: "theirs", size: 1 }, { owned: false });
    const { adopted, refused } = await run(
      Provider.succeed(Box, box),
      Effect.gen(function* unowned() {
        const first = yield* runBox(boxWorkflow(), { label: "a", size: 1 });
        const rowAfterRefusal = yield* getRow;
        expect(rowAfterRefusal).toBeUndefined();
        const second = yield* runBox(boxWorkflow(Resource.adopt), {
          label: "a",
          size: 1,
        });
        return { adopted: second, refused: first };
      })
    );
    expect(refused.run.status).toBe("failed");
    expect(errorOf(refused)?.tag).toBe("ResourceUnowned");
    expect(adopted.run.status).toBe("succeeded");
    expect(box.store.all()).toHaveLength(1);
    expect(box.store.all()[0]?.owned).toBe(true);
    expect(box.store.calls).toMatchObject({ creates: 0, updates: 1 });
  });

  test("adopt as an option", async () => {
    const box = memoryBox();
    box.store.seed("boxes/box", { label: "theirs", size: 1 }, { owned: false });
    const summary = await run(
      Provider.succeed(Box, box),
      runBox(boxWorkflow(undefined, { adopt: true }), { label: "a", size: 1 })
    );
    expect(summary.run.status).toBe("succeeded");
  });

  test("recreates a drifted object", async () => {
    const box = memoryBox();
    const workflow = boxWorkflow();
    const row = await run(
      Provider.succeed(Box, box),
      Effect.gen(function* drift() {
        yield* runBox(workflow, { label: "a", size: 1 });
        const [entry] = box.store.all();
        yield* box.delete({
          fqn: "boxes/box",
          olds: entry?.props as BoxProps,
          output: entry?.attributes as (typeof Box.attributes)["Type"],
          scope: "default",
        });
        yield* runBox(workflow, { label: "a", size: 1 });
        return yield* getRow;
      })
    );
    expect(row?.status).toBe("created");
    expect(box.store.calls.creates).toBe(2);
    expect(box.store.all()).toHaveLength(1);
  });

  test("recovers a creating row without a duplicate", async () => {
    const box = memoryBox();
    const workflow = boxWorkflow();
    const row = await run(
      Provider.succeed(Box, box),
      Effect.gen(function* recover() {
        const state = yield* State.State;
        // A crash after reconcile created the object, before the terminal row.
        yield* state.putResource({
          ...key,
          lifetime: "scope",
          mode: "live",
          props: { label: "a", size: 1 },
          runId: "crashed",
          status: "creating",
          type: "Test.Box",
          updatedAt: Date.now(),
        });
        box.store.seed("boxes/box", { label: "a", size: 1 });
        yield* runBox(workflow, { label: "a", size: 1 });
        return yield* getRow;
      })
    );
    expect(row?.status).toBe("updated");
    expect(box.store.all()).toHaveLength(1);
    expect(box.store.calls.creates).toBe(0);
  });

  test("finds its own object when no row was written", async () => {
    const box = memoryBox();
    box.store.seed("boxes/box", { label: "a", size: 1 });
    const row = await run(
      Provider.succeed(Box, box),
      Effect.andThen(runBox(boxWorkflow(), { label: "a", size: 1 }), getRow)
    );
    expect(row?.status).toBe("created");
    expect(box.store.all()).toHaveLength(1);
  });

  test("recovers an interrupted replacement idempotently", async () => {
    const box = memoryBox({
      diff: () => Effect.succeed({ action: "replace" }),
    });
    const workflow = boxWorkflow();
    const row = await run(
      Provider.succeed(Box, box),
      Effect.gen(function* recoverReplace() {
        const state = yield* State.State;
        const old = box.store.seed("boxes/box", { label: "a", size: 1 });
        const fresh = box.store.seed("boxes/box", { label: "a", size: 2 });
        // Crashed after creating the replacement, before deleting the old one.
        yield* state.putResource({
          ...key,
          attributes: fresh,
          lifetime: "scope",
          mode: "live",
          previous: { attributes: old, props: { label: "a", size: 1 } },
          props: { label: "a", size: 2 },
          runId: "crashed",
          status: "replacing",
          type: "Test.Box",
          updatedAt: Date.now(),
        });
        yield* runBox(workflow, { label: "a", size: 2 });
        return yield* getRow;
      })
    );
    expect(row?.status).toBe("replaced");
    expect(row?.previous).toBeUndefined();
    expect(box.store.all().map((entry) => entry.attributes.id)).toEqual([
      "boxes/box:2",
    ]);
    expect(box.store.calls.creates).toBe(0);
  });

  for (const [form, workflow] of [
    ["option", boxWorkflow(undefined, { lifetime: "run" })],
    ["pipe", boxWorkflow(Resource.Lifetime.run)],
  ] as const) {
    test(`run lifetime deletes at run finish (${form})`, async () => {
      const box = memoryBox();
      const { row, summary } = await run(
        Provider.succeed(Box, box),
        Effect.gen(function* runLifetime() {
          const ran = yield* runBox(workflow, { label: "a", size: 1 });
          return { row: yield* getRow, summary: ran };
        })
      );
      expect(summary.run.status).toBe("succeeded");
      expect(summary.run.result).toEqual({ id: "boxes/box:1" });
      expect(row).toBeUndefined();
      expect(box.store.calls).toMatchObject({ creates: 1, deletes: 1 });
      expect(box.store.all()).toHaveLength(0);
    });
  }

  test("retries DeleteInProgress", async () => {
    let attempts = 0;
    const box = memoryBox({
      onDelete: () =>
        Effect.suspend(() => {
          attempts += 1;
          return attempts < 3
            ? Effect.fail(new Provider.DeleteInProgress({ message: "busy" }))
            : Effect.void;
        }),
    });
    const summary = await run(
      Provider.succeed(Box, box),
      runBox(boxWorkflow(Resource.Lifetime.run), { label: "a", size: 1 })
    );
    expect(summary.run.status).toBe("succeeded");
    expect(summary.run.error).toBeUndefined();
    expect(attempts).toBe(3);
    expect(box.store.all()).toHaveLength(0);
  });

  test("failed checks fail the node before anything is reconciled", async () => {
    const box = memoryBox({
      checks: ({ news }) =>
        news?.label === "forbidden"
          ? Effect.fail(new Provider.CheckFailed({ message: "no" }))
          : Effect.void,
    });
    const { row, summary } = await run(
      Provider.succeed(Box, box),
      Effect.gen(function* checks() {
        const ran = yield* runBox(boxWorkflow(), {
          label: "forbidden",
          size: 1,
        });
        return { row: yield* getRow, summary: ran };
      })
    );
    expect(summary.run.status).toBe("failed");
    expect(errorOf(summary)?.tag).toBe("CheckFailed");
    expect(row).toBeUndefined();
    expect(box.store.calls.creates).toBe(0);
  });

  test("rejects invalid props", async () => {
    const summary = await run(
      Provider.succeed(Box, memoryBox()),
      runBox(
        Workflow.make(
          "boxes",
          { description: "", input: Schema.Struct({}) },
          () => Box("box", { label: "a", size: 1.5 })
        ),
        {}
      )
    );
    expect(errorOf(summary)?.tag).toBe("InvalidProps");
  });

  test("plan reports create/noop/update/replace without side effects", async () => {
    const box = memoryBox({
      diff: ({ news, olds }) =>
        Effect.succeed(
          news.size === olds.size
            ? undefined
            : { action: "replace", deleteFirst: true }
        ),
    });
    const workflow = boxWorkflow();
    const planOf = (props: BoxProps) =>
      Effect.flatMap(Engine.Engine, (engine) =>
        engine.plan(workflow, props, { ...options, mode: "live" })
      ).pipe(Effect.map((result) => result.entries[0]?.change));
    const plans = await run(
      Provider.succeed(Box, box),
      Effect.gen(function* plans() {
        const create = yield* planOf({ label: "a", size: 1 });
        const createdBefore = box.store.calls.creates;
        yield* runBox(workflow, { label: "a", size: 1 });
        const counts = { ...box.store.calls };
        const noop = yield* planOf({ label: "a", size: 1 });
        const update = yield* planOf({ label: "b", size: 1 });
        const replace = yield* planOf({ label: "a", size: 2 });
        const after = { ...box.store.calls, reads: counts.reads };
        return { after, counts, create, createdBefore, noop, replace, update };
      })
    );
    expect(plans.createdBefore).toBe(0);
    expect(plans.create).toEqual({ action: "create" });
    expect(plans.noop).toEqual({ action: "noop" });
    expect(plans.update).toEqual({ action: "update" });
    expect(plans.replace).toEqual({
      action: "replace",
      detail: "delete first",
    });
    expect(plans.after).toEqual(plans.counts);
  });

  test("plan reports adopt, unowned, and unresolved props", async () => {
    const box = memoryBox();
    box.store.seed("boxes/box", { label: "x", size: 1 }, { owned: false });
    const planned = await run(
      Provider.succeed(Box, box),
      Effect.gen(function* plans() {
        const engine = yield* Engine.Engine;
        const adopting = yield* engine.plan(
          boxWorkflow(Resource.adopt),
          { label: "a", size: 1 },
          options
        );
        const refusing = yield* engine.plan(
          boxWorkflow(),
          { label: "a", size: 1 },
          options
        );
        const chained = yield* engine.plan(
          Workflow.make(
            "boxes",
            { description: "", input: Schema.Struct({}) },
            Effect.fn(function* chained() {
              const first = yield* Box("box", { label: "a", size: 1 });
              yield* Box("second", { label: first.id, size: 1 });
            })
          ),
          {},
          options
        );
        return { adopting, chained, refusing };
      })
    );
    expect(planned.adopting.entries[0]?.change.action).toBe("adopt");
    expect(planned.refusing.entries[0]?.change.action).toBe("unknown");
    expect(planned.chained.entries[1]?.change.action).toBe("unknown");
  });

  test("Resource.destroy deletes the object and the row", async () => {
    const box = memoryBox();
    const result = await run(
      Provider.succeed(Box, box),
      Effect.gen(function* destroy() {
        yield* runBox(boxWorkflow(), { label: "a", size: 1 });
        yield* Resource.destroy(key);
        const missing = yield* Effect.flip(Resource.destroy(key));
        return { missing, row: yield* getRow };
      })
    );
    expect(result.row).toBeUndefined();
    expect(box.store.all()).toHaveLength(0);
    expect((result.missing as { _tag: string })._tag).toBe("ResourceNotFound");
  });

  test("Resource.destroy fails without a provider", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* noProvider() {
        const state = yield* State.State;
        yield* state.putResource({
          ...key,
          lifetime: "scope",
          props: {},
          runId: "r",
          status: "created",
          type: "Test.Unknown",
          updatedAt: Date.now(),
        });
        return yield* Effect.flip(Resource.destroy(key));
      }).pipe(Effect.provide(State.memory))
    );
    expect((error as { _tag: string })._tag).toBe("ProviderNotFound");
  });

  test("dual providers use the fake in fake mode and live in live mode", async () => {
    const live = memoryBox();
    const fake = memoryBox();
    const workflow = boxWorkflow();
    await run(
      Provider.dual(Box, {
        fake: Effect.succeed(fake),
        live: Effect.succeed(live),
      }),
      Effect.gen(function* dual() {
        yield* runBox(workflow, { label: "a", size: 1 }, "fake");
        expect(fake.store.all()).toHaveLength(1);
        expect(live.store.all()).toHaveLength(0);
        expect((yield* getRow)?.mode).toBe("fake");
        // Switching modes replaces the fake object with a live one.
        yield* runBox(workflow, { label: "a", size: 1 }, "live");
        expect(fake.store.all()).toHaveLength(0);
        expect(live.store.all()).toHaveLength(1);
        expect((yield* getRow)?.mode).toBe("live");
      })
    );
  });

  test("Provider.effect captures the services lifecycle methods need", async () => {
    class Prefix extends Context.Service<Prefix, { readonly value: string }>()(
      "test/Prefix"
    ) {}
    const created: string[] = [];
    const provider = Provider.effect(
      Box,
      Effect.succeed({
        delete: () => Effect.void,
        read: () => Provider.absent,
        reconcile: ({ fqn, news }: { fqn: string; news: BoxProps }) =>
          Effect.gen(function* reconcile() {
            const prefix = yield* Prefix;
            created.push(prefix.value);
            return { id: `${prefix.value}:${fqn}`, label: news.label };
          }),
      })
    ).pipe(Layer.provide(Layer.succeed(Prefix, { value: "p" })));
    const summary = await run(
      provider,
      runBox(boxWorkflow(), { label: "a", size: 1 })
    );
    expect(summary.run.result).toEqual({ id: "p:boxes/box" });
    expect(created).toEqual(["p"]);
  });
});

/* oxlint-disable max-classes-per-file */
// These two service identities independently exercise selected provider requirements.
// @effect-diagnostics floatingEffect:off missingEffectContext:off
import { expect, test } from "bun:test";

import { Context, Effect, Layer, Schema } from "effect";

import type { Ref } from "../src/index.ts";
import {
  Application,
  Extension,
  Task,
  Workflow,
  WorkflowPatch,
} from "../src/index.ts";

class Client extends Context.Service<Client, { readonly label: string }>()(
  "extension/Client"
) {}
class Cache extends Context.Service<Cache, { readonly label: string }>()(
  "extension/Cache"
) {}
const Input = Schema.Struct({ name: Schema.String });
const Base = Task.make(
  {
    error: Schema.Never,
    id: "base",
    input: Input,
    replay: "manual",
    success: Schema.String,
    version: 1,
  },
  ({ name }) => Effect.succeed(name)
);
const Contributed = Task.make(
  {
    error: Schema.Never,
    id: "acme/tools/inspect",
    input: Input,
    replay: "idempotent",
    success: Schema.String,
    version: 1,
  },
  ({ name }) => Effect.map(Client, (client) => `${client.label}/${name}`)
);
const Cached = Task.implementation(
  { id: "acme/tools/cached", target: Base },
  ({ name }) => Effect.map(Cache, (cache) => `${cache.label}/${name}`)
);
const Review = WorkflowPatch.make(
  { id: "acme/tools/review", target: Base },
  (input) =>
    Effect.gen(function* () {
      const graph = yield* Workflow.Builder;
      yield* graph.approval("review", {
        context: input,
        prompt: "Publish?",
        timeout: "1 hour",
      });
    })
);
const Tools = Extension.make({
  id: "acme/tools",
  implementations: [Cached],
  patches: [Review],
  tasks: { Inspect: Contributed },
  version: "1.0.0",
});
const contracts = {
  artifacts: {},
  id: Tools.id,
  tasks: { Inspect: Task.contract(Contributed.spec) },
  version: Tools.version,
  workflows: {},
};
const Installed = Extension.installed(
  contracts,
  async () => await Promise.resolve(Tools),
  "a".repeat(64)
);
const Flow = Workflow.make(
  {
    error: Schema.Never,
    id: "consumer",
    input: Input,
    success: Schema.String,
    version: 1,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const inspected = yield* graph.task(
      "inspect",
      Installed.tasks.Inspect,
      yield* graph.input(Input)
    );
    return yield* graph.task("publish", Base, { name: inspected });
  })
);
const ClientLive = Layer.succeed(Client, { label: "client" });
const CacheLive = Layer.succeed(Cache, { label: "cache" });
const read = <R>(app: Application.Application<R>) =>
  Application.Registry.pipe(Effect.provide(app.layer));
const binding = (id = "review"): Extension.Binding => ({
  at: ["publish"],
  id,
  use: Review.id,
  workflow: { id: Flow.id, version: 1 },
});

test("typed installed contracts compose into a local graph and load lazily on inclusion", async () => {
  let loads = 0;
  const installed = Extension.installed(
    contracts,
    async () => {
      loads += 1;
      return await Promise.resolve(Tools);
    },
    "b".repeat(64)
  );
  await Effect.runPromise(read(Application.make({ tasks: [Base] })));
  expect(loads).toBe(0);
  const registry = await Effect.runPromise(
    read(
      Application.make({
        extensions: [Extension.use(installed)],
        tasks: [Base],
        workflows: [Flow],
      }).provide(ClientLive)
    )
  );
  expect(loads).toBe(1);
  expect(registry.tasks.get(Base.id)?.providerId).toBeUndefined();
  expect(registry.tasks.get(Contributed.id)?.spec).toBe(Contributed.spec);
  expect(registry.extensions[0]?.digest).toBe("b".repeat(64));
  const task = registry.workflows.get(Flow.id)?.graph.nodes[1];
  expect(task?.kind === "Task" ? task.patches : null).toBeUndefined();
});

test("only explicit provider and patch selections affect the application", async () => {
  const selection = Extension.use(Installed, {
    implementations: [Cached.providerId],
    patches: [binding()],
  });
  const registry = await Effect.runPromise(
    read(
      Application.make({
        extensions: [selection],
        tasks: [Base],
        workflows: [Flow],
      }).provide(Layer.merge(ClientLive, CacheLive))
    )
  );
  expect(registry.tasks.get(Base.id)?.providerId).toBe(Cached.providerId);
  const task = registry.workflows.get(Flow.id)?.graph.nodes[1];
  expect(task?.kind === "Task" ? task.patches?.[0]?.id : null).toBe("review");
  expect(
    Workflow.allNodes(
      (
        registry.workflows.get(Flow.id) ??
        (() => {
          throw new Error("Missing workflow");
        })()
      ).graph
    ).map((node) => node.kind)
  ).toEqual(["Task", "Task", "Approval"]);
});

test("a replacement retains its provider identity through task-level Layer provision", async () => {
  const provided = Cached.provide(CacheLive);
  const extension = Extension.make({
    id: "acme/provided",
    implementations: [provided],
    version: "1.0.0",
  });
  const registry = await Effect.runPromise(
    read(
      Application.make({
        extensions: [
          Extension.use(extension, { implementations: [provided.providerId] }),
        ],
        tasks: [Base],
      })
    )
  );
  expect(registry.tasks.get(Base.id)?.providerId).toBe(Cached.providerId);
  const result = await Effect.runPromise(
    Task.test(provided, { input: { name: "Ada" } })
  );
  expect(result.value).toBe("cache/Ada");
});

test("installed contract identity is checked against the separately loaded implementation", async () => {
  const stale = Extension.installed(
    {
      ...contracts,
      tasks: { Inspect: Task.contract({ ...Contributed.spec }) },
    },
    async () => await Promise.resolve(Tools),
    "c".repeat(64)
  );
  await expect(
    Effect.runPromise(
      read(
        Application.make({ extensions: [Extension.use(stale)] }).provide(
          ClientLive
        )
      )
    )
  ).rejects.toThrow("Noncanonical installed task contract");
  await expect(
    Effect.runPromise(
      read(Application.make({ tasks: [Base], workflows: [Flow] }))
    )
  ).rejects.toThrow("Missing or noncanonical task contract");
});

test("competing providers and noncanonical replacement contracts fail activation", async () => {
  const Other = Task.implementation(
    { id: "acme/tools/other", target: Base },
    () => Effect.succeed("other")
  );
  const Conflict = Extension.make({
    id: "acme/conflict",
    implementations: [Other],
    version: "1.0.0",
  });
  await expect(
    Effect.runPromise(
      read(
        Application.make({
          extensions: [
            Extension.use(Tools, { implementations: [Cached.providerId] }),
            Extension.use(Conflict, { implementations: [Other.providerId] }),
          ],
          tasks: [Base],
        }).provide(Layer.merge(ClientLive, CacheLive))
      )
    )
  ).rejects.toThrow("Conflicting implementations");
  const Fake = Task.implementation(
    { id: "acme/fake/provider", target: Task.contract({ ...Base.spec }) },
    () => Effect.succeed("fake")
  );
  const FakeExtension = Extension.make({
    id: "acme/fake",
    implementations: [Fake],
    version: "1.0.0",
  });
  await expect(
    Effect.runPromise(
      read(
        Application.make({
          extensions: [
            Extension.use(FakeExtension, {
              implementations: [Fake.providerId],
            }),
          ],
          tasks: [Base],
        })
      )
    )
  ).rejects.toThrow("noncanonical replacement target");
});

test("patch bindings reject missing targets, wrong versions and cyclic ordering", async () => {
  const bad: readonly [readonly Extension.Binding[], string][] = [
    [[{ ...binding(), at: ["missing"] }], "Missing patch target"],
    [
      [{ ...binding(), workflow: { id: Flow.id, version: 2 } }],
      "version mismatch",
    ],
    [[{ ...binding(), at: ["inspect"] }], "Noncanonical patch target"],
    [[{ ...binding(), after: ["absent"] }], "same target"],
    [
      [
        { ...binding("one"), after: ["two"] },
        { ...binding("two"), after: ["one"] },
      ],
      "ordering cycle",
    ],
    [[binding(), binding()], "duplicate"],
    [
      [{ ...binding(), workflow: { id: "absent", version: 1 } }],
      "Missing patch workflow",
    ],
  ];
  await Promise.all(
    bad.map(([patches, message]) =>
      expect(
        Effect.runPromise(
          read(
            Application.make({
              extensions: [Extension.use(Tools, { patches })],
              tasks: [Base],
              workflows: [Flow],
            }).provide(ClientLive)
          )
        )
      ).rejects.toThrow(message)
    )
  );
});

// Compile-only proofs: generated contracts preserve inputs/results, and only
// selected implementations add their external service requirements.
export function extensionTypeFixtures() {
  void Effect.runPromise(
    read(
      Application.make({ extensions: [Extension.use(Installed)] }).provide(
        ClientLive
      )
    )
  );
  void Effect.runPromise(
    read(
      Application.make({
        extensions: [
          Extension.use(Installed, { implementations: [Cached.providerId] }),
        ],
        tasks: [Base],
      }).provide(Layer.merge(ClientLive, CacheLive))
    )
  );
  const missingClient = read(
    Application.make({ extensions: [Extension.use(Installed)] })
  );
  // @ts-expect-error Contributed handlers retain Client in the Application Layer.
  void Effect.runPromise(missingClient);
  const missingCache = read(
    Application.make({
      extensions: [
        Extension.use(Installed, { implementations: [Cached.providerId] }),
      ],
      tasks: [Base],
    }).provide(ClientLive)
  );
  // @ts-expect-error The selected replacement additionally requires Cache.
  void Effect.runPromise(missingCache);
  const configuredOptions: Extension.Options<typeof Tools> = {
    implementations: [Cached.providerId],
  };
  const configured = read(
    Application.make({
      extensions: [Extension.use(Installed, configuredOptions)],
      tasks: [Base],
    }).provide(ClientLive)
  );
  // @ts-expect-error Optional configuration may select Cache; its service cannot disappear.
  void Effect.runPromise(configured);
  // @ts-expect-error Generated declarations restrict the replacement identifiers.
  Extension.use(Installed, { implementations: ["acme/tools/not-exported"] });
}

// Compile-only graph fixture. Effects are lazy, so this is never run.
export const extensionGraphTypeFixture = Effect.gen(function* () {
  const graph = yield* Workflow.Builder;
  // @ts-expect-error Installed task inputs retain their declared shape.
  yield* graph.task("bad", Installed.tasks.Inspect, { name: 123 });
  const value = yield* graph.task("valid", Installed.tasks.Inspect, {
    name: "x",
  });
  const typed: Ref.Ref<string> = value;
  // @ts-expect-error Installed task results are not widened.
  const wrong: Ref.Ref<number> = value;
  return { typed, wrong };
});

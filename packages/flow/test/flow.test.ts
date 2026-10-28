import { describe, expect, test } from "bun:test";

import { Context, Effect, Exit, Graph, Schema } from "effect";

import { Flow } from "../src/index.ts";

const StringArray = Schema.Array(Schema.String);

/** Records task start/finish so tests can check ordering. */
const makeLog = () => {
  const events: string[] = [];
  const record = (event: string) => Effect.sync(() => events.push(event));
  return { events, record };
};

const makeTasks = (record: (event: string) => Effect.Effect<unknown>) => {
  const InstallDeps = Flow.Task(
    "InstallDeps",
    {
      description: "Installs dependencies.",
      input: StringArray,
      labels: ["setup"],
      output: Schema.Finite,
    },
    (packages) =>
      Effect.succeed({
        run: Effect.gen(function* installDeps() {
          yield* record("InstallDeps:start");
          // Yield a few times so a racing RunTests would get scheduled first.
          for (let i = 0; i < 10; i += 1) {
            yield* Effect.yieldNow;
          }
          yield* record("InstallDeps:end");
          return packages.length;
        }),
      })
  );

  const RunTests = Flow.Task(
    "RunTests",
    {
      description: "Runs tests after dependencies are installed.",
      input: StringArray,
      labels: ["testing"],
      output: Schema.Boolean,
    },
    (input) =>
      Effect.gen(function* runTests() {
        const installed = yield* Flow.After(InstallDeps, input);
        return {
          run: Effect.gen(function* runTestsRun() {
            yield* record("RunTests:start");
            const count = yield* installed.output;
            yield* record("RunTests:end");
            return count === input.length;
          }),
        };
      })
  );

  return { InstallDeps, RunTests };
};

const packages = ["effect", "typescript"];
const InstallKey = `InstallDeps(${JSON.stringify(packages)})`;
const TestsKey = `RunTests(${JSON.stringify(packages)})`;

describe("Flow.plan", () => {
  test("RunTests depends on InstallDeps in the DAG", async () => {
    const { RunTests } = makeTasks(() => Effect.void);
    const plan = await Effect.runPromise(Flow.plan(RunTests, packages));

    expect(plan.root).toBe(TestsKey);
    expect(plan.order).toEqual([InstallKey, TestsKey]);
    expect(plan.nodes.get(TestsKey)?.dependencies).toEqual([InstallKey]);
    expect(plan.nodes.get(InstallKey)?.dependencies).toEqual([]);

    const install = plan.nodes.get(InstallKey)?.index ?? -1;
    const tests = plan.nodes.get(TestsKey)?.index ?? -1;
    expect(Graph.hasEdge(plan.graph, install, tests)).toBe(true);
    expect(Graph.hasEdge(plan.graph, tests, install)).toBe(false);
    expect(Graph.isAcyclic(plan.graph)).toBe(true);
    expect(plan.nodes.get(TestsKey)?.node.labels).toEqual(["testing"]);

    const mermaid = Flow.toMermaid(plan).split("\n");
    expect(mermaid[0]).toBe("flowchart TD");
    expect(mermaid[1]).toStartWith('  0["InstallDeps');
    expect(mermaid[2]).toStartWith('  1["RunTests');
    expect(mermaid[3]).toBe("  0 --> 1");
  });

  test("planning does not run any task's work", async () => {
    const { events, record } = makeLog();
    const { RunTests } = makeTasks(record);
    await Effect.runPromise(Flow.plan(RunTests, packages));
    expect(events).toEqual([]);
  });

  test("shared dependencies with the same input become one node", async () => {
    const { InstallDeps, RunTests } = makeTasks(() => Effect.void);
    const Lint = Flow.Task(
      "Lint",
      { input: StringArray, output: Schema.Boolean },
      (input) =>
        Effect.gen(function* lint() {
          yield* Flow.After(InstallDeps, input);
          return { run: Effect.succeed(true) };
        })
    );
    const Check = Flow.Task(
      "Check",
      { input: StringArray, output: Schema.Boolean },
      (input) =>
        Effect.gen(function* check() {
          const tests = yield* Flow.After(RunTests, input);
          const lint = yield* Flow.After(Lint, input);
          return {
            run: Effect.all([tests.output, lint.output]).pipe(
              Effect.map(([a, b]) => a && b)
            ),
          };
        })
    );

    const plan = await Effect.runPromise(Flow.plan(Check, packages));
    expect(plan.nodes.size).toBe(4);
    expect(plan.order[0]).toBe(InstallKey);
    expect(plan.order.at(-1)).toBe(`Check(${JSON.stringify(packages)})`);
  });

  test("the same task with different inputs is two nodes", async () => {
    const { InstallDeps } = makeTasks(() => Effect.void);
    const Both = Flow.Task(
      "Both",
      { input: Schema.Void, output: Schema.Finite },
      () =>
        Effect.gen(function* both() {
          const a = yield* Flow.After(InstallDeps, ["a"]);
          const b = yield* Flow.After(InstallDeps, ["b", "c"]);
          return {
            run: Effect.all([a.output, b.output]).pipe(
              Effect.map(([x, y]) => x + y)
            ),
          };
        })
    );
    const plan = await Effect.runPromise(Flow.plan(Both));
    expect(plan.nodes.size).toBe(3);
    expect(await Effect.runPromise(Flow.run(plan))).toBe(3);
  });

  test("cycles fail planning", async () => {
    const Ping: Flow.Task<"Ping", typeof Schema.String, typeof Schema.Void> =
      Flow.Task(
        "Ping",
        { input: Schema.String, output: Schema.Void },
        (input) =>
          Effect.gen(function* ping() {
            // oxlint-disable-next-line no-use-before-define -- bodies run lazily, at plan time.
            yield* Flow.After(Pong, input);
            return { run: Effect.void };
          })
      );
    const Pong = Flow.Task(
      "Pong",
      { input: Schema.String, output: Schema.Void },
      (input) =>
        Effect.gen(function* pong() {
          yield* Flow.After(Ping, input);
          return { run: Effect.void };
        })
    );

    const exit = await Effect.runPromiseExit(Flow.plan(Ping, "x"));
    expect(exit).toEqual(
      Exit.fail(
        new Flow.PlanError({
          message: 'Cycle: Ping("x") -> Pong("x") -> Ping("x")',
        })
      )
    );
  });

  test("invalid input fails planning", async () => {
    const { RunTests } = makeTasks(() => Effect.void);
    const exit = await Effect.runPromiseExit(
      Flow.plan(RunTests, [1] as unknown as string[])
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("Invalid input for RunTests");
  });

  test("After only accepts the upstream task's input type", () => {
    const { InstallDeps } = makeTasks(() => Effect.void);
    Flow.Task("Typed", { input: Schema.Finite, output: Schema.Void }, (n) =>
      Effect.gen(function* typed() {
        // @ts-expect-error InstallDeps takes string[], not number
        yield* Flow.After(InstallDeps, n);
        return { run: Effect.void };
      })
    );
  });
});

describe("Flow.run", () => {
  test("RunTests starts only after InstallDeps finishes", async () => {
    const { events, record } = makeLog();
    const { RunTests } = makeTasks(record);
    const result = await Effect.runPromise(
      Flow.plan(RunTests, packages).pipe(Effect.flatMap(Flow.run))
    );

    expect(result).toBe(true);
    expect(events).toEqual([
      "InstallDeps:start",
      "InstallDeps:end",
      "RunTests:start",
      "RunTests:end",
    ]);
  });

  test("a failed dependency stops dependents from running", async () => {
    const { events, record } = makeLog();
    const Broken = Flow.Task(
      "Broken",
      { input: Schema.Void, output: Schema.Void },
      () => Effect.succeed({ run: Effect.fail("install failed" as const) })
    );
    const After = Flow.Task(
      "After",
      { input: Schema.Void, output: Schema.Void },
      () =>
        Effect.gen(function* after() {
          yield* Flow.After(Broken);
          return { run: record("After:ran") };
        })
    );

    const error = await Effect.runPromise(
      Flow.plan(After).pipe(Effect.flatMap(Flow.run), Effect.flip)
    );
    expect(error).toBe("install failed");
    expect(events).toEqual([]);
  });

  test("outputs are checked against the output schema", async () => {
    const Liar = Flow.Task(
      "Liar",
      { input: Schema.Void, output: Schema.Finite },
      () => Effect.succeed({ run: Effect.succeed(1) })
    );
    const LiarPlan = await Effect.runPromise(Flow.plan(Liar));
    const lied = {
      ...LiarPlan,
      nodes: new Map(
        [...LiarPlan.nodes].map(([key, entry]) => [
          key,
          { ...entry, run: Effect.succeed("not a number") },
        ])
      ),
    };
    const exit = await Effect.runPromiseExit(Flow.run(lied));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("upstream services are required to run the root", async () => {
    class Registry extends Context.Service<
      Registry,
      { readonly url: string }
    >()("test/Registry") {}
    const Fetch = Flow.Task(
      "Fetch",
      { input: Schema.Void, output: Schema.String },
      () => Effect.succeed({ run: Effect.map(Registry, (r) => r.url) })
    );
    const Build = Flow.Task(
      "Build",
      { input: Schema.Void, output: Schema.String },
      () =>
        Effect.gen(function* build() {
          const url = yield* Flow.After(Fetch);
          return { run: url.output };
        })
    );

    const program = Flow.plan(Build).pipe(Effect.flatMap(Flow.run));
    // Registry is required by Fetch, an upstream of Build.
    type Services =
      typeof program extends Effect.Effect<string, unknown, infer R>
        ? R
        : never;
    const requiresRegistry: [Services] extends [Registry] ? true : false = true;
    expect(requiresRegistry).toBe(true);

    const url = await Effect.runPromise(
      program.pipe(
        Effect.provideService(Registry, { url: "https://registry.npmjs.org" })
      )
    );
    expect(url).toBe("https://registry.npmjs.org");
  });
});

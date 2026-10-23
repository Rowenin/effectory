import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Engine,
  Output,
  Provider,
  Resource,
  State,
  Test,
  Workflow,
} from "@effectory/core";
import { Effect, Layer, Schema } from "effect";

import * as Http from "../src/http.ts";
import { Service, makeServiceProvider } from "../src/service.ts";
import { Shell } from "../src/shell.ts";
import { processLayer } from "./harness.ts";

const stateDir = mkdtempSync(path.join(tmpdir(), "effectory-service-"));
const started = new Set<number>();

afterAll(() => {
  for (const pid of started) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already stopped.
    }
  }
  rmSync(stateDir, { force: true, recursive: true });
});

/** A port nothing listens on: bind an ephemeral one, then release it. */
const freePort = async () => {
  const probe = Bun.serve({ fetch: () => new Response(), port: 0 });
  const { port } = probe;
  await probe.stop(true);
  return port ?? 0;
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const server = (port: number) => ({
  args: [
    "-e",
    `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("pong") }); console.log("listening on ${port}");`,
  ],
  command: process.execPath,
  ready: Http.ok(`http://127.0.0.1:${port}/`, { timeoutMs: 10_000 }),
});

const provider = makeServiceProvider({ stateDir, stopTimeoutMs: 2000 });
const engineLayer = Engine.layer.pipe(Layer.provideMerge(State.memory));
const layer = Layer.mergeAll(engineLayer, provider, processLayer);

const fixture = (lifetime: "run" | "scope") =>
  Workflow.make(
    "fixture",
    {
      description: "Start a server and call it",
      input: Schema.Struct({ port: Schema.Int }),
      scope: () => "fixture",
    },
    Effect.fn(function* body({ port }) {
      const api = yield* Service("api", server(port), { lifetime });
      const call = yield* Shell("call", {
        // Depends on the service, so it runs once the service is ready.
        args: Output.map(api.pid, () => [
          "-e",
          `console.log(await (await fetch("http://127.0.0.1:${port}/")).text())`,
        ]),
        command: process.execPath,
      });
      return {
        logFile: api.logFile,
        pid: api.pid,
        response: Output.map(call, (result) => result.stdout.trim()),
      };
    })
  );

interface FixtureResult {
  readonly logFile: string;
  readonly pid: number;
  readonly response: string;
}

const runFixture = (lifetime: "run" | "scope", port: number) =>
  Effect.flatMap(Engine.Engine, (engine) =>
    engine.run(
      fixture(lifetime),
      { port },
      {
        collection: "test",
        mode: "live",
        revision: "r1",
      }
    )
  ).pipe(
    Effect.map((summary) => {
      const result = summary.run.result as FixtureResult | undefined;
      if (result !== undefined) {
        started.add(result.pid);
      }
      return { result, summary };
    })
  );

/** Run a one-Service workflow; report the run status and the node error. */
const runOne = (name: string, props: typeof Service.props.Type) =>
  Effect.runPromise(
    Effect.flatMap(Engine.Engine, (engine) =>
      engine.run(
        Workflow.make(name, { description: "", input: Schema.Struct({}) }, () =>
          Service("api", props)
        ),
        {},
        { collection: "test", mode: "live", revision: "r1" }
      )
    ).pipe(Effect.provide(layer))
  ).then((summary) => ({
    error: summary.nodes.find((row) => row.fqn === `${name}/api`)?.error,
    status: summary.run.status,
  }));

describe("Service", () => {
  test("a run-lifetime service is ready for its dependents and stopped when the run finishes", async () => {
    const port = await freePort();
    const { result, summary } = await Effect.runPromise(
      runFixture("run", port).pipe(Effect.provide(layer))
    );
    expect(summary.run.status).toBe("succeeded");
    expect(result?.response).toBe("pong");
    expect(readFileSync(result?.logFile ?? "", "utf-8")).toContain(
      `listening on ${port}`
    );
    expect(alive(result?.pid ?? 0)).toBe(false);
    expect(
      await Effect.runPromise(Http.check(Http.ok(`http://127.0.0.1:${port}/`)))
    ).toBe(false);
  });

  test("a killed service is restarted by the next run", async () => {
    const port = await freePort();
    const { first, second, third } = await Effect.runPromise(
      Effect.gen(function* restart() {
        const before = yield* runFixture("scope", port);
        process.kill(before.result?.pid ?? 0, "SIGKILL");
        yield* Effect.sleep(100);
        const after = yield* runFixture("scope", port);
        const again = yield* runFixture("scope", port);
        yield* Resource.destroy({
          collection: "test",
          fqn: "fixture/api",
          scope: "fixture",
        });
        return { first: before, second: after, third: again };
      }).pipe(Effect.provide(layer))
    );
    expect(first.result?.response).toBe("pong");
    expect(second.summary.run.status).toBe("succeeded");
    expect(second.result?.response).toBe("pong");
    expect(second.result?.pid).not.toBe(first.result?.pid);
    // A live service with unchanged props is kept.
    expect(third.result?.pid).toBe(second.result?.pid);
    expect(alive(second.result?.pid ?? 0)).toBe(false);
  });

  test("the service outlives the process that started it", async () => {
    const port = await freePort();
    const script = `
      import { Effect } from "effect";
      import { Provider } from "@effectory/core";
      import { Service, makeServiceProvider } from ${JSON.stringify(path.join(import.meta.dir, "../src/service.ts"))};
      const props = ${JSON.stringify(server(port))};
      const program = Effect.flatMap(Provider.tag("Process.Service"), (shape) =>
        shape.live.reconcile({ fqn: "detached/api", news: props, olds: undefined, output: undefined, scope: "detached" })
      ).pipe(Effect.provide(makeServiceProvider({ stateDir: ${JSON.stringify(stateDir)} })));
      console.log((await Effect.runPromise(program)).pid);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: import.meta.dir,
      stderr: "pipe",
      stdout: "pipe",
    });
    const exitCode = await child.exited;
    expect(exitCode).toBe(0);
    const stdout = await new Response(child.stdout).text();
    const pid = Number(stdout.trim());
    started.add(pid);
    expect(alive(pid)).toBe(true);
    expect(
      await Effect.runPromise(Http.check(Http.ok(`http://127.0.0.1:${port}/`)))
    ).toBe(true);
    await Effect.runPromise(
      Effect.flatMap(
        Provider.tag<
          "Process.Service",
          typeof Service.props.Type,
          typeof Service.attributes.Type
        >("Process.Service"),
        (shape) =>
          shape.live.delete({
            fqn: "detached/api",
            olds: server(port),
            output: { logFile: "", pid, startedAt: 0 },
            scope: "detached",
          })
      ).pipe(Effect.provide(provider))
    );
    expect(alive(pid)).toBe(false);
  });

  test("Test.provider", async () => {
    const [create, replace] = [await freePort(), await freePort()];
    const report = await Effect.runPromise(
      Test.provider(Service, {
        cases: { create: server(create), replace: server(replace) },
        layer: provider,
        mode: "live",
      })
    );
    expect(report.steps.map((step) => step.name)).toEqual([
      "create",
      "noop",
      "replace",
      "delete",
      "recover",
    ]);
  });

  test("fails, and stops the process, when it never becomes ready", async () => {
    const port = await freePort();
    const exited = await runOne("broken", {
      args: ["-e", "console.error('boom'); process.exit(3)"],
      command: process.execPath,
      ready: Http.port(port, { timeoutMs: 10_000 }),
    });
    expect(exited.status).toBe("failed");
    expect(exited.error?.message).toContain(
      "exited (code 3) before it was ready"
    );
    expect(exited.error?.message).toContain("boom");

    const pidFile = path.join(stateDir, "hanging.pid");
    const hanging = await runOne("hanging", {
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      ],
      command: process.execPath,
      ready: Http.ok(`http://127.0.0.1:${port}/`, { intervalMs: 20 }),
      readyTimeoutMs: 300,
    });
    expect(hanging.status).toBe("failed");
    expect(hanging.error?.message).toContain("was not ready after 300ms");
    expect(alive(Number(readFileSync(pidFile, "utf-8")))).toBe(false);
  });
});

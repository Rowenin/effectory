// Polling and streaming read the next state only after the preceding read completes.
/* oxlint-disable no-await-in-loop */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import pathModule from "node:path";

import { requestControl } from "@effectory/runtime";
import { Effect } from "effect";

const root = pathModule.resolve(import.meta.dir, "../../../..");
const cli = pathModule.join(root, "packages/cli/src/main.ts");
const deadlineMs = 20_000;

export const until = async <A>(
  label: string,
  read: () => A | Promise<A>,
  ready: (value: A) => boolean
): Promise<A> => {
  const deadline = Date.now() + deadlineMs;
  let latest: A | undefined;
  while (Date.now() < deadline) {
    latest = await read();
    if (ready(latest)) {
      return latest;
    }
    await Bun.sleep(75);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(latest)}`);
};

const bounded = async <A>(
  promise: Promise<A>,
  label: string,
  ms = deadlineMs
): Promise<A> => {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new Error(`Timed out: ${label}`)),
    ms
  );
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
};

export const loopbackFixture = () => {
  const counts = new Map<string, number>();
  let active = 0;
  let peak = 0;
  const blocked = Promise.withResolvers<null>();
  const server = Bun.serve({
    async fetch(request) {
      const path = new URL(request.url).pathname;
      counts.set(path, (counts.get(path) ?? 0) + 1);
      active += 1;
      peak = Math.max(peak, active);
      try {
        const aborted = Promise.withResolvers<null>();
        request.signal.addEventListener("abort", () => aborted.resolve(null), {
          once: true,
        });
        if (request.signal.aborted) {
          aborted.resolve(null);
        }
        await (path.startsWith("/blocked")
          ? Promise.race([blocked.promise, aborted.promise])
          : Bun.sleep(40));
        return new Response(path === "/first" ? "first-committed" : "fixture", {
          status: path.startsWith("/unhealthy") ? 503 : 200,
        });
      } finally {
        active -= 1;
      }
    },
    hostname: "127.0.0.1",
    idleTimeout: 0,
    port: 0,
  });
  return {
    baseUrl: server.url.origin,
    close() {
      blocked.resolve(null);
      server.stop(true);
    },
    counts,
    get peak() {
      return peak;
    },
    release() {
      blocked.resolve(null);
    },
  };
};

export class CliWorkspace {
  readonly path = mkdtempSync(pathModule.join(import.meta.dir, ".workspace-"));
  readonly children = new Set<ReturnType<typeof Bun.spawn>>();
  readonly logs: string[] = [];

  constructor(options: { explicitWorkflows?: boolean } = {}) {
    for (const name of ["package.json", "bun.lock"]) {
      cpSync(pathModule.join(root, name), pathModule.join(this.path, name), {
        recursive: true,
      });
    }
    cpSync(
      pathModule.join(root, ".effectory/automations"),
      pathModule.join(this.path, ".effectory/automations"),
      {
        recursive: true,
      }
    );
    cpSync(
      pathModule.join(root, "packages/sdk/package.json"),
      pathModule.join(this.path, "packages/sdk/package.json"),
      { recursive: true }
    );
    this.copyClosure("packages/sdk/src/index.ts");
    mkdirSync(pathModule.join(this.path, "node_modules/@effectory"), {
      recursive: true,
    });
    symlinkSync(
      pathModule.join(this.path, "packages/sdk"),
      pathModule.join(this.path, "node_modules/@effectory/sdk"),
      "dir"
    );
    // Copied workspace SDK sources need their declared platform dependency;
    // Bun's isolated linker does not hoist it to the checkout root.
    mkdirSync(pathModule.join(this.path, "node_modules/@effect"), {
      recursive: true,
    });
    const platformEntry = Bun.resolveSync(
      "@effect/platform-bun/BunServices",
      pathModule.join(root, "packages/sdk/src")
    );
    symlinkSync(
      pathModule.dirname(pathModule.dirname(platformEntry)),
      pathModule.join(this.path, "node_modules/@effect/platform-bun"),
      "dir"
    );
    // This fixture exercises the legacy root dependency layout.
    writeFileSync(
      pathModule.join(this.path, ".effectory/workspace.json"),
      '{"version":1}'
    );
    const sequential = pathModule.join(
      this.path,
      ".effectory/automations/restart-proof/index.ts"
    );
    mkdirSync(pathModule.dirname(sequential), { recursive: true });
    cpSync(pathModule.join(import.meta.dir, "sequential.ts"), sequential);
    if (options.explicitWorkflows) {
      writeFileSync(
        pathModule.join(this.path, "effectory.run.ts"),
        `
      import { Effectory } from "@effectory/sdk";
      import { Layer } from "effect";
      import healthCheck from "./.effectory/automations/health-check/index.ts";
      import approvedHealthCheck from "./.effectory/automations/approved-health-check/index.ts";
      import restartProof from "./.effectory/automations/restart-proof/index.ts";
      export default Effectory.make({
        services: Layer.empty,
        workflows: [healthCheck, approvedHealthCheck, { ...restartProof, name: "restart-proof" }],
      });
    `
      );
    }
  }

  private copyClosure(file: string, seen = new Set<string>()) {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    const source = readFileSync(pathModule.join(root, file), "utf-8");
    const target = pathModule.join(this.path, file);
    mkdirSync(pathModule.dirname(target), { recursive: true });
    writeFileSync(target, source);
    for (const match of source.matchAll(
      /(?:from\s*|import\s*)["'](?<source>\.[^"']+\.ts)["']/gu
    )) {
      const imported = match.groups?.source;
      if (imported) {
        this.copyClosure(
          pathModule.join(pathModule.dirname(file), imported),
          seen
        );
      }
    }
  }

  spawn(args: string[]) {
    const child = Bun.spawn(
      [process.execPath, cli, ...args, "--workspace", this.path],
      {
        cwd: this.path,
        env: { ...process.env, NO_COLOR: "1" },
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      }
    );
    this.children.add(child);
    return child;
  }

  async command(args: string[], ok = true): Promise<unknown> {
    const child = this.spawn(args);
    try {
      const [code, stdout, stderr] = await bounded(
        Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]),
        `CLI ${args.join(" ")}`
      );
      this.logs.push(`${args.join(" ")}\n${stdout}${stderr}`);
      if ((code === 0) !== ok) {
        throw new Error(
          `Unexpected CLI exit ${code}: ${args.join(" ")}\n${stdout}${stderr}`
        );
      }
      return ok ? JSON.parse(stdout) : { code, stderr, stdout };
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await bounded(child.exited, "command cleanup");
      this.children.delete(child);
    }
  }

  async serve() {
    const child = this.spawn(["serve"]);
    const stderr = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    let output = "";
    try {
      await bounded(
        (async () => {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
              throw new Error(
                `Serve exited before readiness: ${output}${await stderr}`
              );
            }
            output += new TextDecoder().decode(chunk.value);
            try {
              const record = JSON.parse(output.trim()) as { status?: string };
              if (record.status === "ready") {
                return;
              }
            } catch {
              /* Readiness may arrive across multiple stdout chunks. */
            }
          }
        })(),
        "serve readiness"
      );
      if (
        !existsSync(pathModule.join(this.path, ".effectory/state/control.sock"))
      ) {
        throw new Error(
          `Readiness emitted before control socket exists: ${output}`
        );
      }
      // Drain output so a verbose child cannot block on a full stdout pipe.
      void (async () => {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }
            output += new TextDecoder().decode(chunk.value);
          }
          const text = await stderr;
          this.logs.push(`serve\n${output}${text}`);
        } catch {
          // Cleanup can close the reader while output is draining.
        }
      })();
      return child;
    } catch (error) {
      child.kill("SIGKILL");
      await bounded(child.exited, "failed serve cleanup");
      throw new Error(`${String(error)}\n${output}${await stderr}`, {
        cause: error,
      });
    }
  }

  async stop(
    child: ReturnType<typeof Bun.spawn>,
    signal: "SIGTERM" | "SIGKILL" = "SIGTERM"
  ) {
    child.kill(signal);
    try {
      await bounded(child.exited, `${signal} serve`, 8000);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await bounded(child.exited, "serve forced cleanup");
      this.children.delete(child);
    }
  }

  async submit(task: string, input: unknown, key: string) {
    return (await Effect.runPromise(
      requestControl(this.path, {
        input,
        method: "task.run",
        requestKey: key,
        task,
      })
    )) as Run;
  }

  async inspect(id: string) {
    return (await this.command(["run", "inspect", id])) as Run;
  }
  terminal(id: string, status = "succeeded") {
    return until(
      `run ${id} to become ${status}`,
      () => this.inspect(id),
      (run) => {
        if (
          ["succeeded", "failed", "cancelled"].includes(run.status) &&
          run.status !== status
        ) {
          throw new Error(`Unexpected terminal run: ${JSON.stringify(run)}`);
        }
        return run.status === status;
      }
    );
  }
  async approval(id: string) {
    const gates = await until(
      `approval for ${id}`,
      async () => (await this.command(["approval", "list"])) as Gate[],
      (items) => items.some((gate) => gate.runId === id)
    );
    const gate = gates.find((item) => item.runId === id);
    if (!gate) {
      throw new Error("Approval disappeared from the returned list");
    }
    return gate;
  }
  async close() {
    for (const child of this.children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
    await Promise.all(
      [...this.children].map((child) =>
        bounded(child.exited, "test child cleanup")
      )
    );
    rmSync(this.path, { force: true, recursive: true });
  }
}

export interface Run {
  id: string;
  status: string;
  result?:
    | { total: number; healthy: number; unhealthy: number; actionPath: string }
    | string;
}
export interface Artifact {
  id: string;
  runId: string;
  name: string;
  value: unknown;
  schemaVersion: number;
}
export interface Gate {
  id: string;
  runId: string;
  status: string;
  digest: string;
  revision: string;
  review: { summary: unknown; action: { path: string; value: unknown } };
}

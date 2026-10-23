/**
 * `Service` is a background process as a Resource: `reconcile` starts it
 * detached and waits for its readiness probe, `read` checks that its PID is
 * still alive (so a resumed or rerun workflow restarts a crashed service),
 * and `delete` stops it (SIGTERM to its process group, then SIGKILL). It is
 * meant for `Lifetime.run`, so the service stops when the run finishes:
 *
 * ```ts
 * const api = yield* Service("api", {
 *   command: "bun", args: ["serve.ts"], cwd: checkout.path,
 *   ready: Http.ok("http://127.0.0.1:3000/health"),
 * }).pipe(Lifetime.run);
 * ```
 *
 * State lives in `$EFFECTORY_HOME/services/<fqn>-<digest(scope, fqn)>/`
 * (default `~/.effectory`): `service.log` (stdout and stderr, appended across
 * restarts) and `service.json` (the PID, so `read` can find a process an
 * interrupted run started). The process is detached and unreferenced, so it
 * outlives the fiber and the CLI process that started it.
 *
 * Fake mode runs the same provider: a fixture server is as real as the
 * commands that use it. Any prop change replaces the process (stop, then
 * start, so ports are free). PIDs are not checked for reuse by an unrelated
 * process.
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { Json, Provider, Resource } from "@effectory/core";
import { Data, Effect, Schema } from "effect";

import * as Http from "./http.ts";
import { digest, effectoryHome, slug } from "./internal/home.ts";

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

export const ServiceProps = Schema.Struct({
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  command: nonEmpty,
  cwd: Schema.optionalKey(nonEmpty),
  /** Added to the runner's environment. */
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Readiness probe (`Http.ok`, `Http.port`, `Http.delay`); without one the service is ready once spawned. */
  ready: Schema.optionalKey(Http.Probe),
  /** Overrides the probe's own timeout. */
  readyTimeoutMs: Schema.optionalKey(positiveInteger),
});
type Props = typeof ServiceProps.Type;

export const ServiceAttributes = Schema.Struct({
  logFile: Schema.String,
  pid: positiveInteger,
  /** Epoch milliseconds. */
  startedAt: Schema.Finite,
});
type Attributes = typeof ServiceAttributes.Type;

export const Service = Resource.make("Process.Service", {
  attributes: ServiceAttributes,
  description:
    "A detached background process with a readiness probe, stopped on delete",
  props: ServiceProps,
});

/** The service could not be started or did not become ready. */
export class ServiceError extends Data.TaggedError("ServiceError")<{
  readonly message: string;
}> {}

export interface ServiceProviderOptions {
  /** Where per-service logs and PID files live. Default `$EFFECTORY_HOME/services`. */
  readonly stateDir?: string;
  /** How long to wait after SIGTERM before SIGKILL. Default 5 s. */
  readonly stopTimeoutMs?: number;
}

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code: unknown }).code
    : undefined;

/** Whether `pid` (or, with a negative id, its process group) exists. */
const exists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return errorCode(error) === "EPERM";
  }
};

/** Whether the service or anything left in its process group is running. */
const running = (pid: number) => exists(pid) || exists(-pid);

/** Signal the process group the service leads, falling back to the process. */
const signal = (pid: number, name: NodeJS.Signals) => {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, name);
      return;
    } catch {
      // Try the next target; a missing process is already stopped.
    }
  }
};

const pollMs = 50;

const waitUntilStopped = (pid: number, timeoutMs: number) =>
  Effect.gen(function* waitForExit() {
    const deadline = Date.now() + timeoutMs;
    while (running(pid) && Date.now() < deadline) {
      yield* Effect.sleep(pollMs);
    }
    return !running(pid);
  });

/** SIGTERM, wait, SIGKILL. A missing process is fine. */
const stop = (pid: number, timeoutMs: number) =>
  Effect.gen(function* stopService() {
    if (!running(pid)) {
      return;
    }
    signal(pid, "SIGTERM");
    if (yield* waitUntilStopped(pid, timeoutMs)) {
      return;
    }
    signal(pid, "SIGKILL");
    if (!(yield* waitUntilStopped(pid, 2000))) {
      return yield* new ServiceError({
        message: `Process ${pid} did not stop after SIGKILL`,
      });
    }
  });

const logTail = (logFile: string) => {
  try {
    return readFileSync(logFile, "utf-8").trim().slice(-2000);
  } catch {
    return "";
  }
};

/** Start the process detached, logging to `logFile`; resolves once spawned. */
const launch = (props: Props, logFile: string) =>
  Effect.callback<
    { readonly pid: number; readonly exited: () => string | undefined },
    ServiceError
  >((resume) => {
    let exit: string | undefined;
    const log = openSync(logFile, "a");
    try {
      const child = spawn(props.command, [...(props.args ?? [])], {
        cwd: props.cwd,
        detached: true,
        env: { ...process.env, ...props.env },
        stdio: ["ignore", log, log],
      });
      child.once("exit", (code, exitSignal) => {
        exit = exitSignal ?? `code ${code}`;
      });
      child.once("error", (error) => {
        resume(
          Effect.fail(
            new ServiceError({
              message: `Could not start ${props.command}: ${error.message}`,
            })
          )
        );
      });
      child.once("spawn", () => {
        child.unref();
        const { pid } = child;
        if (pid === undefined) {
          resume(
            Effect.fail(
              new ServiceError({ message: `${props.command} has no PID` })
            )
          );
          return;
        }
        resume(Effect.succeed({ exited: () => exit, pid }));
      });
    } finally {
      closeSync(log);
    }
  });

/** The Service provider, with its state directory and stop timeout. */
export const makeServiceProvider = (options: ServiceProviderOptions = {}) =>
  Provider.effect(
    Service,
    Effect.sync(() => {
      const stateDir = path.resolve(
        options.stateDir ?? path.join(effectoryHome(), "services")
      );
      const stopTimeoutMs = options.stopTimeoutMs ?? 5000;
      const directory = (scope: string, fqn: string) =>
        path.join(stateDir, `${slug(fqn)}-${digest([scope, fqn])}`);
      const pidFile = (scope: string, fqn: string) =>
        path.join(directory(scope, fqn), "service.json");

      const recorded = (scope: string, fqn: string) => {
        try {
          return Schema.decodeUnknownSync(ServiceAttributes)(
            JSON.parse(readFileSync(pidFile(scope, fqn), "utf-8"))
          );
        } catch {
          // No readable PID file: nothing was started for this key.
        }
      };

      const start = (scope: string, fqn: string, props: Props) =>
        Effect.gen(function* startService() {
          const dir = directory(scope, fqn);
          const logFile = path.join(dir, "service.log");
          yield* Effect.try({
            catch: (error) =>
              new ServiceError({
                message: `Could not create ${dir}: ${String(error)}`,
              }),
            try: () => mkdirSync(dir, { recursive: true }),
          });
          const startedAt = Date.now();
          const child = yield* launch(props, logFile);
          const attributes: Attributes = {
            logFile,
            pid: child.pid,
            startedAt,
          };
          writeFileSync(pidFile(scope, fqn), JSON.stringify(attributes));
          if (props.ready !== undefined) {
            yield* Http.wait(props.ready, {
              abort: Effect.suspend(() => {
                const exit = child.exited();
                return exit === undefined
                  ? Effect.void
                  : Effect.fail(
                      new Http.NotReady({
                        message: `${props.command} exited (${exit}) before it was ready`,
                        probe: props.ready as typeof Http.Probe.Type,
                      })
                    );
              }),
              timeoutMs: props.readyTimeoutMs,
            }).pipe(
              Effect.catchTag("NotReady", (error) =>
                stop(child.pid, stopTimeoutMs).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.sync(() =>
                      rmSync(pidFile(scope, fqn), { force: true })
                    )
                  ),
                  Effect.andThen(
                    Effect.fail(
                      new ServiceError({
                        message: `${error.message}\n${logTail(logFile)}`.trim(),
                      })
                    )
                  )
                )
              )
            );
          }
          return attributes;
        });

      const service: Provider.ProviderService<Props, Attributes> = {
        delete: ({ fqn, output, scope }) =>
          Effect.gen(function* deleteService() {
            yield* stop(output.pid, stopTimeoutMs);
            const file = pidFile(scope, fqn);
            if (existsSync(file) && recorded(scope, fqn)?.pid === output.pid) {
              rmSync(file, { force: true });
            }
          }),
        diff: ({ news, olds }) =>
          Effect.succeed(
            Json.canonical(olds) === Json.canonical(news)
              ? { action: "noop" }
              : { action: "replace", deleteFirst: true }
          ),
        read: ({ fqn, output, scope }) =>
          Effect.sync(() => {
            const found = output ?? recorded(scope, fqn);
            return found !== undefined && exists(found.pid) ? found : undefined;
          }),
        reconcile: ({ fqn, news, output, scope }) =>
          Effect.gen(function* reconcileService() {
            if (output !== undefined && exists(output.pid)) {
              if (news.ready !== undefined) {
                yield* Http.wait(news.ready, {
                  timeoutMs: news.readyTimeoutMs,
                });
              }
              return output;
            }
            return yield* start(scope, fqn, news);
          }),
      };
      return service;
    })
  );

/** The Service provider with default state and stop timeout. */
export const ServiceProvider = makeServiceProvider();

/**
 * Readiness probes for background processes (see `Service`). A probe is
 * plain data, so it can live in a Resource's props and be recorded; `wait`
 * evaluates it by polling until it passes or its deadline expires.
 *
 * ```ts
 * Service("api", { command: "bun", args: ["serve.ts"], ready: Http.ok("http://127.0.0.1:3000/health") });
 * ```
 */
import { connect } from "node:net";

import { Data, Effect, Schema } from "effect";

const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

const timing = {
  /** Delay between attempts. Default 100 ms. */
  intervalMs: Schema.optionalKey(positiveInteger),
  /** How long to keep trying. Default 30 s. */
  timeoutMs: Schema.optionalKey(positiveInteger),
};

/** Ready when a GET of `url` answers 2xx. */
export const HttpProbe = Schema.TaggedStruct("http", {
  ...timing,
  url: Schema.String.check(Schema.isMinLength(1)),
});

/** Ready when a TCP connection to `host:port` succeeds. */
export const PortProbe = Schema.TaggedStruct("port", {
  ...timing,
  /** Default `127.0.0.1`. */
  host: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  port: positiveInteger,
});

/** Ready after a fixed delay. */
export const DelayProbe = Schema.TaggedStruct("delay", {
  ms: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const Probe = Schema.Union([HttpProbe, PortProbe, DelayProbe]);
type ProbeValue = typeof Probe.Type;

/** A probe did not pass before its deadline. */
export class NotReady extends Data.TaggedError("NotReady")<{
  readonly message: string;
  readonly probe: ProbeValue;
}> {}

type Timing = Partial<Pick<typeof HttpProbe.Type, "intervalMs" | "timeoutMs">>;

/** Ready when a GET of `url` answers 2xx. */
export const ok = (url: string, options: Timing = {}): ProbeValue => ({
  _tag: "http",
  url,
  ...options,
});

/** Ready when a TCP connection to `port` (on `host`, default 127.0.0.1) succeeds. */
export const port = (
  portNumber: number,
  options: Timing & { readonly host?: string } = {}
): ProbeValue => ({ _tag: "port", port: portNumber, ...options });

/** Ready after `ms` milliseconds. */
export const delay = (ms: number): ProbeValue => ({ _tag: "delay", ms });

/** The probe constructors under one name: `Ready.http(url)`, `Ready.port(3000)`, `Ready.delay(500)`. */
export const Ready = { delay, http: ok, port };

const defaultIntervalMs = 100;
const defaultTimeoutMs = 30_000;
const attemptTimeoutMs = 2000;

const httpOnce = (url: string) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(url, { redirect: "manual", signal });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 300;
  }).pipe(
    Effect.timeoutOrElse({
      duration: attemptTimeoutMs,
      orElse: () => Effect.succeed(false),
    }),
    Effect.orElseSucceed(() => false)
  );

const portOnce = (host: string, portNumber: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = connect({ host, port: portNumber });
    const settle = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resume(Effect.succeed(result));
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(attemptTimeoutMs, () => settle(false));
    return Effect.sync(() => socket.destroy());
  });

/** Evaluate `probe` once (a `delay` probe passes immediately). */
export const check = (probe: ProbeValue): Effect.Effect<boolean> => {
  switch (probe._tag) {
    case "http": {
      return httpOnce(probe.url);
    }
    case "port": {
      return portOnce(probe.host ?? "127.0.0.1", probe.port);
    }
    default: {
      return Effect.succeed(true);
    }
  }
};

export interface WaitOptions {
  /** Overrides the probe's own timeout. */
  readonly timeoutMs?: number | undefined;
  /** Checked between attempts; fail it to stop waiting early (e.g. the process exited). */
  readonly abort?: Effect.Effect<void, NotReady> | undefined;
}

/** Poll `probe` until it passes; fail with `NotReady` at the deadline. */
export const wait = (
  probe: ProbeValue,
  options: WaitOptions = {}
): Effect.Effect<void, NotReady> => {
  if (probe._tag === "delay") {
    return Effect.sleep(probe.ms);
  }
  const intervalMs = probe.intervalMs ?? defaultIntervalMs;
  const timeoutMs = options.timeoutMs ?? probe.timeoutMs ?? defaultTimeoutMs;
  const target =
    probe._tag === "http"
      ? probe.url
      : `${probe.host ?? "127.0.0.1"}:${probe.port}`;
  const poll: Effect.Effect<void, NotReady> = Effect.gen(
    function* pollReadiness() {
      while (!(yield* check(probe))) {
        if (options.abort) {
          yield* options.abort;
        }
        yield* Effect.sleep(intervalMs);
      }
    }
  );
  return poll.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new NotReady({
            message: `${target} was not ready after ${timeoutMs}ms`,
            probe,
          })
        ),
    })
  );
};

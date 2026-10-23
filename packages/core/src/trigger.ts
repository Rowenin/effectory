/**
 * Triggers start workflow runs from schedules and webhooks. `effectory serve`
 * serves them with `Trigger.serve`, injecting how a run is dispatched.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { Clock, Cron, Data, Effect, Redacted, Result } from "effect";
import type { Scope } from "effect";

import { SecretStore } from "./secret.ts";
import * as Target from "./target.ts";
import type * as Workflow from "./workflow.ts";

export class InvalidTrigger extends Data.TaggedError("InvalidTrigger")<{
  readonly message: string;
}> {}

/** What a webhook's `verify` and `map` see of the HTTP request. */
export interface WebhookRequest {
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Accepts or rejects a webhook delivery. */
export type Verify = (
  request: WebhookRequest
) => Effect.Effect<boolean, never, SecretStore>;

/** Turns a webhook event into encoded workflow input; `undefined` ignores it. */
export type MapEvent = (
  event: unknown,
  request: { readonly headers: Readonly<Record<string, string>> }
) => unknown;

/** Where a trigger sends runs: a Target or a workflow with a fixed input. */
export type Destination =
  | Target.Any
  | { readonly workflow: Workflow.Any; readonly input: unknown };

export interface Schedule {
  readonly _tag: "Schedule";
  readonly name: string;
  readonly cron: string;
  readonly schedule: Cron.Cron;
  readonly workflow: Workflow.Any;
  readonly target: Target.Any | undefined;
  /** Encoded input; a Target's preset when the destination is a Target. */
  readonly input: unknown;
}

export interface Webhook {
  readonly _tag: "Webhook";
  readonly name: string;
  /** Path, starting with `/`. */
  readonly route: string;
  readonly workflow: Workflow.Any;
  readonly target: Target.Any | undefined;
  readonly verify: Verify | undefined;
  readonly map: MapEvent;
}

export type Trigger = Schedule | Webhook;

export const isTrigger = (value: unknown): value is Trigger =>
  typeof value === "object" &&
  value !== null &&
  ((value as { _tag?: unknown })._tag === "Schedule" ||
    (value as { _tag?: unknown })._tag === "Webhook");

const parseCron = (cron: string, timezone?: string) => {
  const parsed = Cron.parse(cron, timezone);
  if (Result.isFailure(parsed)) {
    throw new InvalidTrigger({
      message: `Invalid cron "${cron}": ${parsed.failure.message}`,
    });
  }
  return parsed.success;
};

/** The first time `cron` fires strictly after `now`. */
export const nextFire = (cron: Cron.Cron | string, now: number | Date): Date =>
  Cron.next(typeof cron === "string" ? parseCron(cron) : cron, now);

/**
 * Run a workflow on a cron schedule (5 fields, or 6 with seconds). The
 * expression is validated here.
 *
 * ```ts
 * export const nightly = Trigger.schedule("0 3 * * *", cypressApp);
 * ```
 */
export const schedule = (
  cron: string,
  destination: Destination,
  options?: { readonly name?: string; readonly timezone?: string }
): Schedule => {
  const parsed = parseCron(cron, options?.timezone);
  const target = Target.isTarget(destination) ? destination : undefined;
  return {
    _tag: "Schedule",
    cron,
    input: destination.input,
    name:
      options?.name ?? `${target?.name ?? destination.workflow.name}@${cron}`,
    schedule: parsed,
    target,
    workflow: destination.workflow,
  };
};

export type WebhookOptions = {
  readonly route: string;
  readonly name?: string;
  readonly verify?: Verify;
  readonly map: MapEvent;
} & (
  | { readonly workflow: Workflow.Any; readonly target?: undefined }
  | { readonly target: Target.Any; readonly workflow?: undefined }
);

/**
 * Start a run for each accepted POST to `route`. With a Target, `map`'s
 * result is merged over the Target's preset.
 *
 * ```ts
 * Trigger.webhook({
 *   route: "/github",
 *   target: cypressApp,
 *   verify: Trigger.githubSignature("gh-webhook"),
 *   map: (event: any) => event.action === "opened" ? { pr: event.number } : undefined,
 * });
 * ```
 */
export const webhook = (options: WebhookOptions): Webhook => {
  const route = options.route.startsWith("/")
    ? options.route
    : `/${options.route}`;
  const workflow = options.target?.workflow ?? options.workflow;
  if (workflow === undefined) {
    throw new InvalidTrigger({
      message: `Webhook ${route} needs a workflow or a target`,
    });
  }
  return {
    _tag: "Webhook",
    map: options.map,
    name: options.name ?? route,
    route,
    target: options.target,
    verify: options.verify,
    workflow,
  };
};

/**
 * Verify GitHub's `x-hub-signature-256` (HMAC-SHA256 of the body with the
 * webhook secret), comparing in constant time.
 */
export const githubSignature =
  (secretName: string): Verify =>
  (request) =>
    Effect.gen(function* verifyGithubSignature() {
      const store = yield* SecretStore;
      const secret = yield* store.get(secretName).pipe(Effect.option);
      const header = request.headers["x-hub-signature-256"];
      if (secret._tag === "None" || header === undefined) {
        if (secret._tag === "None") {
          yield* Effect.logWarning(
            `Webhook secret ${secretName} is not configured`
          );
        }
        return false;
      }
      const expected = `sha256=${createHmac("sha256", Redacted.value(secret.value)).update(request.body).digest("hex")}`;
      const given = Buffer.from(header);
      const wanted = Buffer.from(expected);
      return given.length === wanted.length && timingSafeEqual(given, wanted);
    });

/** Starts a run; injected by the CLI. Returns the run id. */
export type Dispatch = (
  workflow: Workflow.Any,
  input: unknown,
  meta: { readonly trigger: string; readonly target?: string }
) => Effect.Effect<string, unknown>;

export interface ServeOptions {
  readonly port: number;
  readonly hostname?: string;
  readonly dispatch: Dispatch;
}

/** A running trigger server. */
export interface Server {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
}

const json = (status: number, body?: unknown) =>
  body === undefined
    ? new Response(null, { status })
    : Response.json(body, { status });

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const metaOf = (trigger: Trigger) =>
  trigger.target === undefined
    ? { trigger: trigger.name }
    : { target: trigger.target.name, trigger: trigger.name };

/** Parse the body as JSON and map it to input. */
const parseEvent = (
  hook: Webhook,
  body: string,
  headers: Readonly<Record<string, string>>
):
  | { readonly _tag: "Mapped"; readonly input: unknown }
  | { readonly _tag: "Invalid"; readonly error: string } => {
  let event: unknown;
  try {
    event = body.length === 0 ? undefined : JSON.parse(body);
  } catch {
    return { _tag: "Invalid", error: "Body is not JSON" };
  }
  try {
    return { _tag: "Mapped", input: hook.map(event, { headers }) };
  } catch (error) {
    return { _tag: "Invalid", error: messageOf(error) };
  }
};

const handleWebhook = (
  hook: Webhook,
  request: Request,
  dispatch: Dispatch
): Effect.Effect<Response, never, SecretStore> =>
  Effect.gen(function* handleDelivery() {
    if (request.method !== "POST") {
      return json(405, { error: "Use POST" });
    }
    const body = yield* Effect.promise(() => request.text());
    const headers = Object.fromEntries(request.headers);
    if (hook.verify && !(yield* hook.verify({ body, headers }))) {
      return json(401, { error: "Invalid signature" });
    }
    const parsed = parseEvent(hook, body, headers);
    if (parsed._tag === "Invalid") {
      return json(400, { error: parsed.error });
    }
    const mapped = parsed.input;
    if (mapped === undefined) {
      return json(204);
    }
    const input = hook.target
      ? Target.resolve(hook.target, mapped as Record<string, unknown>)
      : mapped;
    const runId = yield* dispatch(hook.workflow, input, metaOf(hook));
    return json(202, { runId });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Webhook ${hook.route} failed`, cause).pipe(
        Effect.as(json(500, { error: "Dispatch failed" }))
      )
    )
  );

const runSchedule = (trigger: Schedule, dispatch: Dispatch) =>
  Effect.gen(function* fireOnce() {
    const now = yield* Clock.currentTimeMillis;
    const at = nextFire(trigger.schedule, now).getTime();
    yield* Effect.sleep(Math.max(0, at - now));
    yield* dispatch(trigger.workflow, trigger.input, metaOf(trigger)).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`Schedule ${trigger.name} failed`, cause)
      )
    );
  }).pipe(Effect.forever);

/**
 * Serve webhooks over HTTP (`Bun.serve`) and run schedules until the scope
 * closes. Responds 202 `{ runId }`, 204 when `map` ignores the event, 401 on
 * a bad signature, 404 for unknown routes.
 *
 * ```ts
 * yield* Effect.scoped(Trigger.serve(triggers, { port, dispatch }).pipe(Effect.andThen(Effect.never)));
 * ```
 */
export const serve = (
  triggers: readonly Trigger[],
  options: ServeOptions
): Effect.Effect<Server, InvalidTrigger, SecretStore | Scope.Scope> =>
  Effect.gen(function* serveTriggers() {
    const routes = new Map<string, Webhook>();
    for (const trigger of triggers) {
      if (trigger._tag === "Webhook") {
        if (routes.has(trigger.route)) {
          return yield* new InvalidTrigger({
            message: `Two webhooks use route ${trigger.route}`,
          });
        }
        routes.set(trigger.route, trigger);
      }
    }
    const context = yield* Effect.context<SecretStore>();
    const run = Effect.runPromiseWith(context);
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          fetch: (request) => {
            const hook = routes.get(new URL(request.url).pathname);
            return hook === undefined
              ? json(404, { error: "Unknown route" })
              : run(handleWebhook(hook, request, options.dispatch));
          },
          port: options.port,
          ...(options.hostname === undefined
            ? {}
            : { hostname: options.hostname }),
        })
      ),
      (running) => Effect.promise(() => running.stop(true))
    );
    for (const trigger of triggers) {
      if (trigger._tag === "Schedule") {
        yield* Effect.forkScoped(runSchedule(trigger, options.dispatch));
      }
    }
    return {
      hostname: server.hostname ?? "localhost",
      port: server.port ?? options.port,
      url: server.url.toString(),
    };
  });

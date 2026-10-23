/* oxlint-disable max-classes-per-file -- the Resource error types live with Resource. */
/**
 * A Resource converges external state through its Provider. Its state row is
 * keyed by `(collection, scope, FQN)`, so reruns update the same object.
 * Execution is write-ahead: an intent row (`creating`, `updating`,
 * `replacing`) before the provider acts, a terminal row after.
 */
import { Context, Data, Effect, Schedule, Schema } from "effect";

import * as Json from "./json.ts";
import * as Node from "./node.ts";
import type {
  ExecContext,
  Mode,
  NodeOptions,
  PlanContext,
  PlannedChange,
  Registry,
} from "./node.ts";
import type * as Output from "./output.ts";
import * as Provider from "./provider.ts";
import type { ResourceRow, ResourceStatus, StateShape } from "./state.ts";
import { State } from "./state.ts";

export class InvalidProps extends Data.TaggedError("InvalidProps")<{
  readonly message: string;
}> {}

export class InvalidAttributes extends Data.TaggedError("InvalidAttributes")<{
  readonly message: string;
}> {}

/** `Resource.destroy` found no state row for the key. */
export class ResourceNotFound extends Data.TaggedError("ResourceNotFound")<{
  readonly message: string;
}> {}

/** No provider for a state row's Resource type is in context. */
export class ProviderNotFound extends Data.TaggedError("ProviderNotFound")<{
  readonly message: string;
  readonly type: string;
}> {}

export type ResourceLifetime = "run" | "scope";

/** Resource-specific options, also settable with `Lifetime.run` and `adopt`. */
export interface ResourceDefaults {
  /** `scope` (default) keeps the object across runs; `run` deletes it when the run finishes. */
  readonly lifetime?: ResourceLifetime;
  /** Take over an object `read` reports as `Unowned` instead of failing. */
  readonly adopt?: boolean;
}

export type ResourceOptions = NodeOptions & ResourceDefaults;

export interface Definition<P, A> {
  readonly description?: string;
  readonly props: Schema.Codec<P, unknown>;
  readonly attributes: Schema.Codec<A, unknown>;
}

export interface Resource<Type extends string, P, A> {
  (
    name: string,
    props: Output.Input<P>,
    options?: ResourceOptions
  ): Effect.Effect<Output.Output<A>, never, Registry | Provider.Provider<Type>>;
  readonly _tag: "Resource";
  readonly type: Type;
  readonly description: string | undefined;
  readonly props: Schema.Codec<P, unknown>;
  readonly attributes: Schema.Codec<A, unknown>;
}

/** Any Resource. */
// oxlint-disable-next-line typescript/no-explicit-any -- variance escape hatch for collections
export type Any = Resource<string, any, any>;

export const isResource = (value: unknown): value is Any =>
  typeof value === "function" &&
  (value as { _tag?: unknown })._tag === "Resource";

/** Resource options applied to every Resource registered inside an effect. */
export const Defaults = Context.Reference<ResourceDefaults>(
  "effectory/ResourceDefaults",
  { defaultValue: () => ({}) }
);

const withDefaults =
  (options: ResourceDefaults) =>
  <X, E, R>(self: Effect.Effect<X, E, R>): Effect.Effect<X, E, R> =>
    Effect.flatMap(Defaults, (current) =>
      Effect.provideService(self, Defaults, { ...current, ...options })
    );

/** Pipeable lifetimes: `Worktree("checkout", props).pipe(Lifetime.run)`. */
export const Lifetime = {
  run: withDefaults({ lifetime: "run" }),
  scope: withDefaults({ lifetime: "scope" }),
};

/** Adopt an existing object `read` reports as `Unowned`. */
export const adopt = withDefaults({ adopt: true });

const terminal: Record<"creating" | "updating" | "replacing", ResourceStatus> =
  {
    creating: "created",
    replacing: "replaced",
    updating: "updated",
  };

const settled = new Set<ResourceStatus>(["created", "updated", "replaced"]);

const deleteSchedule = Schedule.exponential("20 millis");

interface Codecs<P, A> {
  readonly validateProps: (value: unknown) => Effect.Effect<P, InvalidProps>;
  readonly validateAttributes: (
    value: unknown
  ) => Effect.Effect<A, InvalidAttributes>;
  readonly encodeProps: (value: P) => Effect.Effect<unknown>;
  readonly encodeAttributes: (value: A) => Effect.Effect<unknown>;
  readonly decodeProps: (value: unknown) => Effect.Effect<P>;
  readonly decodeAttributes: (value: unknown) => Effect.Effect<A>;
}

const codecsOf = <P, A>(definition: {
  readonly props: Schema.Codec<P, unknown>;
  readonly attributes: Schema.Codec<A, unknown>;
}): Codecs<P, A> => {
  const props = Schema.toCodecJson(definition.props) as unknown as Schema.Codec<
    P,
    unknown
  >;
  const attributes = Schema.toCodecJson(
    definition.attributes
  ) as unknown as Schema.Codec<A, unknown>;
  const validateProps = Schema.decodeUnknownEffect(
    Schema.toType(definition.props)
  );
  const validateAttributes = Schema.decodeUnknownEffect(
    Schema.toType(definition.attributes)
  );
  return {
    decodeAttributes: (value) =>
      Schema.decodeUnknownEffect(attributes)(value).pipe(Effect.orDie),
    decodeProps: (value) =>
      Schema.decodeUnknownEffect(props)(value).pipe(Effect.orDie),
    encodeAttributes: (value) =>
      Schema.encodeUnknownEffect(attributes)(value).pipe(
        Effect.map(Json.toJson),
        Effect.orDie
      ),
    encodeProps: (value) =>
      Schema.encodeUnknownEffect(props)(value).pipe(
        Effect.map(Json.toJson),
        Effect.orDie
      ),
    validateAttributes: (value) =>
      validateAttributes(value).pipe(
        Effect.mapError(
          (issue) => new InvalidAttributes({ message: String(issue) })
        )
      ),
    validateProps: (value) =>
      validateProps(value).pipe(
        Effect.mapError((issue) => new InvalidProps({ message: String(issue) }))
      ),
  };
};

type Key = Pick<ResourceRow, "collection" | "scope" | "fqn">;

/** `read`, with `Unowned` results unwrapped (we hold a state row for it). */
const readOwned = <P, A>(
  service: Provider.ProviderService<P, A>,
  input: Provider.ReadInput<P, A>
) =>
  Effect.map(service.read(input), (found) =>
    Provider.isUnowned(found) ? (found.attributes as A) : found
  );

/** Delete through the provider, retrying `DeleteInProgress`. */
const deleteWithRetry = <P, A>(
  service: Provider.ProviderService<P, A>,
  input: Provider.DeleteInput<P, A>
) =>
  service.delete(input).pipe(
    Effect.retry({
      schedule: deleteSchedule,
      times: 8,
      while: (error) => error instanceof Provider.DeleteInProgress,
    })
  );

const check = <P, A>(
  service: Provider.ProviderService<P, A>,
  input: Provider.CheckInput<P, A>
) => (service.checks ? service.checks(input) : Effect.void);

/** The default diff: canonical-JSON equal props are a noop, anything else an update. */
const decide = <P, A>(
  service: Provider.ProviderService<P, A>,
  input: Provider.DiffInput<P, A>,
  codecs: Codecs<P, A>
) =>
  Effect.gen(function* decideChange() {
    const custom = service.diff ? yield* service.diff(input) : undefined;
    if (custom !== undefined) {
      return custom;
    }
    const olds = yield* codecs.encodeProps(input.olds);
    const news = yield* codecs.encodeProps(input.news);
    return {
      action: Json.canonical(olds) === Json.canonical(news) ? "noop" : "update",
    } satisfies Provider.Diff;
  });

/**
 * Delete the object a state row describes (and a replacement's previous
 * object), then the row. Objects never recorded are looked up with `read`;
 * unowned ones are left alone.
 */
const destroyRow = <P, A>(
  state: StateShape,
  service: Provider.ProviderService<P, A>,
  codecs: Codecs<P, A>,
  row: ResourceRow
) =>
  Effect.gen(function* destroyResource() {
    const olds = yield* codecs.decodeProps(row.props);
    let output =
      row.attributes === undefined
        ? undefined
        : yield* codecs.decodeAttributes(row.attributes);
    if (output === undefined) {
      const found = yield* service.read({
        fqn: row.fqn,
        olds,
        output,
        scope: row.scope,
      });
      output = Provider.isUnowned(found) ? undefined : found;
    }
    yield* check(service, {
      fqn: row.fqn,
      olds,
      operation: "delete",
      output,
      scope: row.scope,
    });
    yield* state.putResource({
      ...row,
      status: "deleting",
      updatedAt: Date.now(),
    });
    if (row.previous?.attributes !== undefined) {
      yield* deleteWithRetry(service, {
        fqn: row.fqn,
        olds: yield* codecs.decodeProps(row.previous.props),
        output: yield* codecs.decodeAttributes(row.previous.attributes),
        scope: row.scope,
      });
    }
    if (output !== undefined) {
      yield* deleteWithRetry(service, {
        fqn: row.fqn,
        olds,
        output,
        scope: row.scope,
      });
    }
    yield* state.deleteResource(row);
  });

interface Converge<P, A> {
  readonly ctx: ExecContext;
  readonly key: Key;
  readonly codecs: Codecs<P, A>;
  readonly shape: Provider.ProviderShape<P, A>;
  readonly service: Provider.ProviderService<P, A>;
  readonly news: P;
  readonly lifetime: ResourceLifetime;
}

/** Write a state row for this run. */
const writeRow = <P, A>(
  run: Converge<P, A>,
  status: ResourceStatus,
  fields: {
    readonly attributes?: A | undefined;
    readonly previous?: { readonly props: P; readonly attributes?: A };
  }
) =>
  Effect.gen(function* writeResourceRow() {
    const { codecs, ctx } = run;
    const previous = fields.previous
      ? {
          props: yield* codecs.encodeProps(fields.previous.props),
          ...(fields.previous.attributes === undefined
            ? {}
            : {
                attributes: yield* codecs.encodeAttributes(
                  fields.previous.attributes
                ),
              }),
        }
      : undefined;
    yield* ctx.state.putResource({
      ...run.key,
      lifetime: run.lifetime,
      mode: ctx.mode,
      props: yield* codecs.encodeProps(run.news),
      runId: ctx.runId,
      status,
      type: run.shape.resource.type,
      updatedAt: Date.now(),
      ...(fields.attributes === undefined
        ? {}
        : { attributes: yield* codecs.encodeAttributes(fields.attributes) }),
      ...(previous === undefined ? {} : { previous }),
    });
  });

/** Checks, intent row, reconcile, terminal row. */
const reconcileTo = <P, A>(
  run: Converge<P, A>,
  intent: "creating" | "updating" | "replacing",
  current: { readonly olds: P | undefined; readonly output: A | undefined }
) =>
  Effect.gen(function* reconcileResource() {
    const { fqn, scope } = run.key;
    const input = { fqn, news: run.news, scope, ...current };
    yield* check(run.service, { ...input, operation: "reconcile" });
    yield* writeRow(run, intent, { attributes: current.output });
    const attributes = yield* run.codecs.validateAttributes(
      yield* run.service.reconcile(input)
    );
    yield* writeRow(run, terminal[intent], { attributes });
    return attributes;
  });

/** Replace `output` with a new object reconciled to the new props. */
const replace = <P, A>(
  run: Converge<P, A>,
  olds: P,
  output: A,
  options: {
    readonly deleteFirst: boolean;
    /** The service that owns the old object, when it differs (mode switch). */
    readonly previousService?: Provider.ProviderService<P, A>;
  }
) =>
  Effect.gen(function* replaceResource() {
    const { fqn, scope } = run.key;
    const previousService = options.previousService ?? run.service;
    const created = {
      fqn,
      news: run.news,
      olds: undefined,
      output: undefined,
      scope,
    };
    yield* check(run.service, { ...created, operation: "reconcile" });
    yield* check(previousService, {
      fqn,
      olds,
      operation: "delete",
      output,
      scope,
    });
    const previous = { attributes: output, props: olds };
    yield* writeRow(run, "replacing", { previous });
    if (options.deleteFirst) {
      yield* deleteWithRetry(previousService, { fqn, olds, output, scope });
      yield* writeRow(run, "replacing", {});
    }
    const attributes = yield* run.codecs.validateAttributes(
      yield* run.service.reconcile(created)
    );
    if (!options.deleteFirst) {
      yield* writeRow(run, "replacing", { attributes, previous });
      yield* deleteWithRetry(previousService, { fqn, olds, output, scope });
    }
    yield* writeRow(run, "replaced", { attributes });
    return attributes;
  });

/**
 * Finish a replacement interrupted mid-way: delete the previous object
 * (idempotent), then converge whatever the new object became.
 */
const recoverReplace = <P, A>(run: Converge<P, A>, row: ResourceRow) =>
  Effect.gen(function* recoverReplacement() {
    const { codecs, service } = run;
    const { fqn, scope } = run.key;
    const olds = yield* codecs.decodeProps(row.props);
    const pending =
      row.attributes === undefined
        ? undefined
        : yield* codecs.decodeAttributes(row.attributes);
    if (row.previous?.attributes !== undefined) {
      yield* deleteWithRetry(service, {
        fqn,
        olds: yield* codecs.decodeProps(row.previous.props),
        output: yield* codecs.decodeAttributes(row.previous.attributes),
        scope,
      });
      yield* writeRow(run, "replacing", { attributes: pending });
    }
    const found = yield* readOwned(service, {
      fqn,
      olds,
      output: pending,
      scope,
    });
    return yield* reconcileTo(run, "replacing", {
      olds: found === undefined ? undefined : olds,
      output: found,
    });
  });

const converge = <P, A>(run: Converge<P, A>, adopting: boolean) =>
  Effect.gen(function* convergeResource() {
    const { codecs, ctx, service, news } = run;
    const { fqn, scope } = run.key;
    const row = yield* ctx.state.getResource(run.key);
    if (row === undefined) {
      const found = yield* service.read({
        fqn,
        olds: news,
        output: undefined,
        scope,
      });
      if (Provider.isUnowned(found)) {
        if (!adopting) {
          return yield* new Provider.ResourceUnowned({
            fqn,
            message: `${fqn}: ${run.shape.resource.type} already exists and is not owned by this collection; use adopt to take it over`,
            type: run.shape.resource.type,
          });
        }
        return yield* reconcileTo(run, "creating", {
          olds: undefined,
          output: found.attributes as A,
        });
      }
      return yield* reconcileTo(run, "creating", {
        olds: undefined,
        output: found,
      });
    }
    if (row.status === "replacing") {
      return yield* recoverReplace(run, row);
    }
    const olds = yield* codecs.decodeProps(row.props);
    const stored =
      row.attributes === undefined
        ? undefined
        : yield* codecs.decodeAttributes(row.attributes);
    const rowMode = row.mode ?? ctx.mode;
    if (rowMode !== ctx.mode) {
      // The object belongs to the other mode's provider: replace it.
      const previousService = Provider.forMode(run.shape, rowMode);
      const existing = yield* readOwned(previousService, {
        fqn,
        olds,
        output: stored,
        scope,
      });
      if (existing === undefined) {
        return yield* reconcileTo(run, "creating", {
          olds: undefined,
          output: undefined,
        });
      }
      return yield* replace(run, olds, existing, {
        deleteFirst: true,
        previousService,
      });
    }
    const current = yield* readOwned(service, {
      fqn,
      olds,
      output: stored,
      scope,
    });
    if (current === undefined) {
      return yield* reconcileTo(run, "creating", {
        olds: undefined,
        output: undefined,
      });
    }
    if (!settled.has(row.status)) {
      return yield* reconcileTo(run, "updating", { olds, output: current });
    }
    const change = yield* decide(
      service,
      { fqn, news, olds, output: current, scope },
      codecs
    );
    if (change.action === "update") {
      return yield* reconcileTo(run, "updating", { olds, output: current });
    }
    if (change.action === "replace") {
      return yield* replace(run, olds, current, {
        deleteFirst: change.deleteFirst ?? false,
      });
    }
    yield* writeRow(run, row.status, { attributes: current });
    return current;
  });

const planChange = <P, A>(
  ctx: PlanContext,
  shape: Provider.ProviderShape<P, A>,
  codecs: Codecs<P, A>,
  adopting: boolean
) =>
  Effect.gen(function* planResource() {
    const service = Provider.forMode(shape, ctx.mode);
    const { fqn, scope } = ctx;
    const row = yield* ctx.state.getResource(ctx);
    if (!ctx.input.resolved) {
      return {
        action: "unknown",
        detail: row
          ? "props known at execution"
          : "props known at execution; no state row",
      } satisfies PlannedChange;
    }
    const news = yield* codecs.validateProps(ctx.input.value);
    if (row === undefined) {
      const found = yield* service.read({
        fqn,
        olds: news,
        output: undefined,
        scope,
      });
      if (Provider.isUnowned(found)) {
        return adopting
          ? ({ action: "adopt" } satisfies PlannedChange)
          : ({
              action: "unknown",
              detail: "exists and is not owned; set adopt to take it over",
            } satisfies PlannedChange);
      }
      return found === undefined
        ? ({ action: "create" } satisfies PlannedChange)
        : ({
            action: "update",
            detail: "found an object from an interrupted run",
          } satisfies PlannedChange);
    }
    if (row.status === "replacing") {
      return {
        action: "replace",
        detail: "recovering an interrupted replacement",
      } satisfies PlannedChange;
    }
    const olds = yield* codecs.decodeProps(row.props);
    const stored =
      row.attributes === undefined
        ? undefined
        : yield* codecs.decodeAttributes(row.attributes);
    if ((row.mode ?? ctx.mode) !== ctx.mode) {
      return {
        action: "replace",
        detail: `switching from ${row.mode} to ${ctx.mode} mode`,
      } satisfies PlannedChange;
    }
    const current = yield* readOwned(service, {
      fqn,
      olds,
      output: stored,
      scope,
    });
    if (current === undefined) {
      return {
        action: "create",
        detail: "the object is gone",
      } satisfies PlannedChange;
    }
    if (!settled.has(row.status)) {
      return {
        action: "update",
        detail: `recovering from ${row.status}`,
      } satisfies PlannedChange;
    }
    const change = yield* decide(
      service,
      { fqn, news, olds, output: current, scope },
      codecs
    );
    if (change.action === "replace" && change.deleteFirst) {
      return {
        action: "replace",
        detail: "delete first",
      } satisfies PlannedChange;
    }
    return { action: change.action } satisfies PlannedChange;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed<PlannedChange>({
        action: "unknown",
        detail: String(cause),
      })
    )
  );

/**
 * Declare a Resource type.
 *
 * ```ts
 * export const Comment = Resource.make("GitHub.PullRequestComment", {
 *   props: Schema.Struct({ number: Schema.Int, body: Schema.String }),
 *   attributes: Schema.Struct({ commentId: Schema.Int, url: Schema.String }),
 * });
 * const summary = yield* Comment("summary", { number: pr, body });
 * ```
 */
export const make = <const Type extends string, P, A>(
  type: Type,
  definition: Definition<P, A>
): Resource<Type, P, A> => {
  const codecs = codecsOf(definition);
  const codec = Schema.toCodecJson(
    definition.attributes
  ) as unknown as Schema.Codec<unknown, unknown>;

  const register = (
    name: string,
    props: Output.Input<P>,
    options?: ResourceOptions
  ) =>
    Effect.gen(function* registerResource() {
      const shape = yield* Provider.tag<Type, P, A>(type);
      const defaults = yield* Defaults;
      const {
        adopt: adoptOption,
        lifetime: lifetimeOption,
        ...rest
      } = options ?? {};
      const lifetime = lifetimeOption ?? defaults.lifetime ?? "scope";
      const adopting = adoptOption ?? defaults.adopt ?? false;
      return yield* Node.register<A>({
        codec,
        execute: (ctx) =>
          Effect.gen(function* executeResource() {
            const news = yield* codecs.validateProps(ctx.input);
            const attributes = yield* converge(
              {
                codecs,
                ctx,
                key: {
                  collection: ctx.collection,
                  fqn: ctx.fqn,
                  scope: ctx.scope,
                },
                lifetime,
                news,
                service: Provider.forMode(shape, ctx.mode),
                shape,
              },
              adopting
            );
            return Node.succeeded(attributes);
          }),
        ...(lifetime === "run"
          ? {
              finish: (ctx) =>
                Effect.gen(function* finishResource() {
                  const row = yield* ctx.state.getResource(ctx);
                  if (row !== undefined) {
                    yield* destroyRow(
                      ctx.state,
                      Provider.forMode(shape, row.mode ?? ctx.mode),
                      codecs,
                      row
                    );
                  }
                }),
            }
          : {}),
        input: props,
        kind: "resource",
        name,
        options: rest,
        plan: (ctx) => planChange(ctx, shape, codecs, adopting),
        record: true,
        reuse: "never",
        type,
      });
    });

  return Object.assign(register, {
    _tag: "Resource" as const,
    attributes: definition.attributes,
    description: definition.description,
    props: definition.props,
    type,
  }) as Resource<Type, P, A>;
};

/**
 * Delete one resource by key: its object through the provider for the row's
 * type and mode, then its state row. Backs `effectory resource delete`.
 */
export const destroy = (key: {
  readonly collection: string;
  readonly scope: string;
  readonly fqn: string;
  /** Mode whose provider deletes the object when the row does not record one. Default `live`. */
  readonly mode?: Mode;
}) =>
  Effect.gen(function* destroyResource() {
    const state = yield* State;
    const row = yield* state.getResource(key);
    if (row === undefined) {
      return yield* new ResourceNotFound({
        message: `No resource ${key.fqn} in scope ${key.scope} of ${key.collection}`,
      });
    }
    const found = yield* Effect.serviceOption(Provider.tag(row.type));
    if (found._tag === "None") {
      return yield* new ProviderNotFound({
        message: `No provider for ${row.type} (resource ${row.fqn})`,
        type: row.type,
      });
    }
    const shape = found.value;
    yield* destroyRow(
      state,
      Provider.forMode(shape, row.mode ?? key.mode ?? "live"),
      codecsOf(shape.resource),
      row
    );
  });

import { Effect, Schema } from "effect";
import type { Layer } from "effect";
import type { Pipeable } from "effect/Pipeable";
import { pipeArguments } from "effect/Pipeable";
import type * as NativeWorkflow from "effect/workflow/Workflow";

import { AutomationError, requireName } from "./authoring.ts";
import type { Codec } from "./authoring.ts";
import * as Automation from "./automation.ts";
import type { Approval, Artifacts } from "./services.ts";
import type * as Task from "./task.ts";

// ---------------------------------------------------------------------------
// References: typed paths into the workflow input and earlier step outputs.
// A binding function runs once, when the plan is built, against a proxy; it
// returns a template of references and literals that the interpreter resolves
// for each run. Nothing in a binding runs during execution.
// ---------------------------------------------------------------------------

const RefTypeId: unique symbol = Symbol.for("effectory/Workflow/Ref");
const CondTypeId: unique symbol = Symbol.for("effectory/Workflow/Cond");

/** A typed reference to a value available when a step runs. */
export interface Ref<out A> {
  readonly [RefTypeId]: {
    readonly path: readonly string[];
    readonly _A: () => A;
  };
}

/** A reference whose fields are themselves references. */
export type Refs<A> = Ref<A> &
  (A extends readonly unknown[]
    ? unknown
    : A extends object
      ? { readonly [K in keyof A & string]-?: Refs<A[K]> }
      : unknown);

/** A value for each field: a literal or a reference of the same type. */
export type Bind<A> = { readonly [K in keyof A]: A[K] | Ref<A[K]> };

/** What bindings can reference: the workflow input and finished steps. */
export type Scope<I, Steps> = Refs<{
  readonly input: I;
  readonly steps: Steps;
}>;

/** A condition evaluated against the run's values. */
export interface Cond {
  readonly [CondTypeId]: (values: Values) => boolean;
}

interface Values {
  readonly input: unknown;
  readonly steps: Record<string, unknown>;
  readonly each?: unknown;
}

const ref = (path: readonly string[]): unknown =>
  new Proxy(Object.create(null), {
    get: (_, property) => {
      if (property === RefTypeId) {
        return { path };
      }
      return typeof property === "string"
        ? ref([...path, property])
        : undefined;
    },
    has: (_, property) => property === RefTypeId,
  });
const scope = ref([]) as Scope<never, never>;

const isRef = (value: unknown): value is Ref<unknown> =>
  typeof value === "object" && value !== null && RefTypeId in value;

const read = (target: Ref<unknown>, values: Values) => {
  let current: unknown = values;
  for (const key of target[RefTypeId].path) {
    if (current === null || current === undefined) {
      return;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

/** Replace every reference in a template with its value. */
const resolve = (template: unknown, values: Values): unknown => {
  if (isRef(template)) {
    return read(template, values);
  }
  if (Array.isArray(template)) {
    return template.map((item) => resolve(item, values));
  }
  if (
    typeof template === "object" &&
    template !== null &&
    Object.getPrototypeOf(template) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [
        key,
        resolve(value, values),
      ])
    );
  }
  return template;
};

/** Conditions over references. */
export const Expr = {
  and: (...conditions: readonly Cond[]): Cond => ({
    [CondTypeId]: (values) =>
      conditions.every((condition) => condition[CondTypeId](values)),
  }),
  eq: <A>(left: Ref<A>, right: NoInfer<A> | Ref<A>): Cond => ({
    [CondTypeId]: (values) => resolve(left, values) === resolve(right, values),
  }),
  not: (condition: Cond): Cond => ({
    [CondTypeId]: (values) => !condition[CondTypeId](values),
  }),
  or: (...conditions: readonly Cond[]): Cond => ({
    [CondTypeId]: (values) =>
      conditions.some((condition) => condition[CondTypeId](values)),
  }),
};

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

type Node =
  | {
      readonly _tag: "step";
      readonly name: string;
      readonly task: Task.Any;
      readonly input: unknown;
    }
  | {
      readonly _tag: "each";
      readonly name: string;
      readonly items: unknown;
      readonly task: Task.Any;
      readonly input: unknown;
      readonly concurrency: number | "unbounded";
    }
  | {
      readonly _tag: "compute";
      readonly name: string;
      readonly f: (args: never) => unknown;
      readonly input: unknown;
    }
  | {
      readonly _tag: "approve";
      readonly key: string;
      readonly title: string;
      readonly review: unknown;
      readonly when: Cond | undefined;
    }
  | {
      readonly _tag: "publish";
      readonly name: string;
      readonly schema: Codec;
      readonly value: unknown;
    }
  | {
      readonly _tag: "call";
      readonly name: string;
      readonly plan: Plan<unknown, unknown, unknown, unknown>;
      readonly input: unknown;
      readonly result: unknown;
    };

const PlanTypeId: unique symbol = Symbol.for("effectory/Workflow/Plan");

/**
 * A workflow under construction: its input, the outputs of its steps so far,
 * and the errors and services its steps need. Finish it with `returns`.
 */
export interface Plan<I, Steps, E, R> extends Pipeable {
  readonly [PlanTypeId]: {
    readonly _I: () => I;
    readonly _Steps: () => Steps;
    readonly _E: () => E;
    readonly _R: () => R;
  };
  readonly name: string;
  readonly description: string;
  readonly input: Codec & NativeWorkflow.AnyStructSchema;
  readonly key: unknown;
  readonly nodes: readonly Node[];
}

const plan = <I, Steps, E, R>(
  base: Omit<Plan<I, Steps, E, R>, typeof PlanTypeId | "pipe">
): Plan<I, Steps, E, R> =>
  ({
    ...base,
    pipe() {
      // oxlint-disable-next-line prefer-rest-params -- pipeArguments reads IArguments.
      return pipeArguments(this, arguments);
    },
  }) as unknown as Plan<I, Steps, E, R>;

// Step outputs, approval keys, and artifact names are separate namespaces.
const identity = (node: Node) => {
  switch (node._tag) {
    case "approve": {
      return { label: "an approval", name: node.key };
    }
    case "publish": {
      return { label: "an artifact", name: node.name };
    }
    default: {
      return { label: "a step", name: node.name };
    }
  }
};

const append = <I, Steps, E, R>(
  self: Plan<unknown, unknown, unknown, unknown>,
  node: Node
): Plan<I, Steps, E, R> => {
  const { label, name } = identity(node);
  requireName(name);
  if (
    self.nodes.some((existing) => {
      const other = identity(existing);
      return other.label === label && other.name === name;
    })
  ) {
    throw new Error(`Workflow ${self.name} already has ${label} named ${name}`);
  }
  return plan({ ...self, nodes: [...self.nodes, node] });
};

/** Start a workflow plan. `key` derives the run's idempotency key from input. */
export const make = <I extends Codec & NativeWorkflow.AnyStructSchema>(
  name: string,
  options: {
    readonly description: string;
    readonly input: I;
    readonly key: (
      scope: Scope<I["Type"], Record<never, never>>
    ) => Ref<string>;
  }
): Plan<I["Type"], Record<never, never>, never, never> =>
  plan({
    description: options.description,
    input: options.input,
    key: options.key(scope as Scope<I["Type"], Record<never, never>>),
    name,
    nodes: [],
  });

/** Run a Task once. Its output is available to later steps as `steps[name]`. */
export const step =
  <
    const Name extends string,
    T extends Task.Any,
    I,
    Steps,
    const Input extends Bind<Task.Input<T>>,
  >(
    name: Name,
    task: T,
    bind: (scope: Scope<I, Steps>) => Input
  ) =>
  <E, R>(
    self: Plan<I, Steps, E, R>
  ): Plan<
    I,
    Steps & Readonly<Record<Name, Task.Success<T>>>,
    E | Task.Error<T>,
    R | Task.Services<T>
  > =>
    append(self as Plan<unknown, unknown, unknown, unknown>, {
      _tag: "step",
      input: bind(scope as Scope<I, Steps>),
      name,
      task,
    });

/** Run a Task once per item, concurrently. Each run is recorded under `name/item`. */
export const each =
  <
    const Name extends string,
    T extends Task.Any,
    A,
    I,
    Steps,
    const Input extends Bind<Task.Input<T>>,
  >(
    name: Name,
    items: readonly A[] | ((scope: Scope<I, Steps>) => Ref<readonly A[]>),
    task: T,
    bind: (scope: Scope<I, Steps>, each: Refs<A>) => Input,
    options: { readonly concurrency?: number | "unbounded" } = {}
  ) =>
  <E, R>(
    self: Plan<I, Steps, E, R>
  ): Plan<
    I,
    Steps & Readonly<Record<Name, readonly Task.Success<T>[]>>,
    E | Task.Error<T>,
    R | Task.Services<T>
  > =>
    append(self as Plan<unknown, unknown, unknown, unknown>, {
      _tag: "each",
      concurrency: options.concurrency ?? "unbounded",
      input: bind(scope as Scope<I, Steps>, ref(["each"]) as Refs<A>),
      items:
        typeof items === "function" ? items(scope as Scope<I, Steps>) : items,
      name,
      task,
    });

/** Derive a value with a pure function. It is recomputed on replay, not recorded. */
export const compute =
  <
    const Name extends string,
    Args,
    B,
    I,
    Steps,
    const Input extends Bind<Args>,
  >(
    name: Name,
    f: (args: Args) => B,
    bind: (scope: Scope<I, Steps>) => Input
  ) =>
  <E, R>(
    self: Plan<I, Steps, E, R>
  ): Plan<I, Steps & Readonly<Record<Name, B>>, E, R> =>
    append(self as Plan<unknown, unknown, unknown, unknown>, {
      _tag: "compute",
      f: f as (args: never) => unknown,
      input: bind(scope as Scope<I, Steps>),
      name,
    });

/** Wait for a person to approve. Rejection fails the run before later steps. */
export const approve =
  <I, Steps>(
    key: string,
    options: {
      readonly title: string;
      readonly review: (scope: Scope<I, Steps>) => unknown;
      readonly when?: (scope: Scope<I, Steps>) => Cond;
    }
  ) =>
  <E, R>(
    self: Plan<I, Steps, E, R>
  ): Plan<I, Steps, E | AutomationError, R | Approval> =>
    append(self as Plan<unknown, unknown, unknown, unknown>, {
      _tag: "approve",
      key,
      review: options.review(scope as Scope<I, Steps>),
      title: options.title,
      when: options.when?.(scope as Scope<I, Steps>),
    });

/** Publish a named artifact. */
export const publish =
  <
    S extends Codec,
    I,
    Steps,
    const Value extends Ref<S["Type"]> | Bind<S["Type"]>,
  >(
    name: string,
    schema: S,
    value: (scope: Scope<I, Steps>) => Value
  ) =>
  <E, R>(
    self: Plan<I, Steps, E, R>
  ): Plan<I, Steps, E | AutomationError, R | Artifacts> =>
    append(self as Plan<unknown, unknown, unknown, unknown>, {
      _tag: "publish",
      name,
      schema,
      value: value(scope as Scope<I, Steps>),
    });

/**
 * Run a finished workflow as one step of this run. Its steps, approvals, and
 * artifacts are recorded under `name/`; its result is `steps[name]`.
 */
export const call =
  <
    const Name extends string,
    D extends AnyDefinition,
    I,
    Steps,
    const Input extends Bind<DefinitionInput<D>>,
  >(
    name: Name,
    definition: D,
    bind: (scope: Scope<I, Steps>) => Input
  ) =>
  <E, R>(
    self: Plan<I, Steps, E, R>
  ): Plan<
    I,
    Steps & Readonly<Record<Name, DefinitionSuccess<D>>>,
    E | DefinitionError<D>,
    R | DefinitionServices<D>
  > =>
    append(self as Plan<unknown, unknown, unknown, unknown>, {
      _tag: "call",
      input: bind(scope as Scope<I, Steps>),
      name,
      plan: definition.plan,
      result: definition.result,
    });

/** The Tasks a plan runs, by step name, including those of called workflows. */
export const tasks = (
  self: Plan<unknown, unknown, unknown, unknown>
): readonly { readonly step: string; readonly task: Task.Any }[] =>
  self.nodes.flatMap((node) => {
    switch (node._tag) {
      case "step":
      case "each": {
        return [{ step: node.name, task: node.task }];
      }
      case "call": {
        return tasks(node.plan).map((entry) => ({
          step: `${node.name}/${entry.step}`,
          task: entry.task,
        }));
      }
      default: {
        return [];
      }
    }
  });

const itemKey = (item: unknown, index: number) =>
  typeof item === "string" || typeof item === "number"
    ? String(item)
    : String(index);

// The interpreter: each node in order, keyed by its step name. A called
// workflow's nodes run here too, keyed under the call's name.
const interpret = (
  nodes: readonly Node[],
  input: unknown,
  prefix = ""
): Effect.Effect<Values, unknown, never> =>
  Effect.gen(function* runPlan() {
    const steps: Record<string, unknown> = {};
    const values = (): Values => ({ input, steps });
    for (const node of nodes) {
      switch (node._tag) {
        case "step": {
          steps[node.name] = yield* node.task(
            resolve(node.input, values()) as never,
            { key: `${prefix}${node.name}` }
          );
          break;
        }
        case "each": {
          const items = resolve(node.items, values()) as readonly unknown[];
          steps[node.name] = yield* Effect.forEach(
            items,
            (item, index) =>
              node.task(
                resolve(node.input, { ...values(), each: item }) as never,
                { key: `${prefix}${node.name}/${itemKey(item, index)}` }
              ),
            { concurrency: node.concurrency }
          );
          break;
        }
        case "compute": {
          steps[node.name] = node.f(resolve(node.input, values()) as never);
          break;
        }
        case "approve": {
          if (node.when === undefined || node.when[CondTypeId](values())) {
            yield* Automation.approve({
              key: `${prefix}${node.key}`,
              review: resolve(node.review, values()),
              title: node.title,
            });
          }
          break;
        }
        case "publish": {
          yield* Automation.publish(`${prefix}${node.name}`, {
            schema: node.schema,
            value: resolve(node.value, values()),
          });
          break;
        }
        case "call": {
          const childInput = yield* Schema.decodeUnknownEffect(node.plan.input)(
            resolve(node.input, values())
          ).pipe(
            Effect.mapError(
              (cause) =>
                new AutomationError({
                  message: String(cause),
                  operation: `${prefix}${node.name}`,
                  reason: "invalid-input",
                })
            )
          );
          const child = yield* interpret(
            node.plan.nodes,
            childInput,
            `${prefix}${node.name}/`
          );
          steps[node.name] = resolve(node.result, child);
          break;
        }
        default: {
          break;
        }
      }
    }
    return values();
  }) as Effect.Effect<Values, unknown, never>;

/**
 * Finish a plan with its result. The returned definition registers in
 * `Effectory.make({ workflows })`, which checks the services its Tasks need.
 */
export const returns =
  <
    S extends Codec,
    I,
    Steps,
    const Value extends Ref<S["Type"]> | Bind<S["Type"]>,
  >(
    schema: S,
    value: (scope: Scope<I, Steps>) => Value
  ) =>
  <E, R>(self: Plan<I, Steps, E, R>) => {
    const result = value(scope as Scope<I, Steps>);
    const errors = tasks(self as Plan<unknown, unknown, unknown, unknown>).map(
      ({ task }) => task.error
    );
    const definition = Automation.define({
      description: self.description,
      error: (errors.length === 0
        ? Schema.Never
        : Schema.Union(errors)) as unknown as Codec,
      execute: (input) =>
        interpret(self.nodes, input).pipe(
          Effect.map((values) => resolve(result, values))
        ),
      idempotencyKey: (input) =>
        String(resolve(self.key, { input, steps: {} })),
      input: self.input,
      name: self.name,
      success: schema,
    });
    return {
      ...definition,
      plan: self as Plan<unknown, unknown, unknown, unknown>,
      result,
    } as unknown as Definition<typeof definition.workflow, R, I>;
  };

/** A finished workflow, ready for `Effectory.make({ workflows })`. */
export interface Definition<
  W extends NativeWorkflow.Any,
  R,
  I = W["payloadSchema"]["Type"],
> {
  // The plan's input type; the native workflow's payload type is erased.
  readonly [InputTypeId]?: () => I;
  readonly name: string;
  readonly description: string;
  readonly workflow: W;
  readonly implementation: Layer.Layer<never, never, R>;
  readonly plan: Plan<unknown, unknown, unknown, unknown>;
  /** The result template `returns` resolves against the run's values. */
  readonly result: unknown;
}

declare const InputTypeId: unique symbol;

// oxlint-disable-next-line typescript/no-explicit-any -- matches any finished workflow.
type AnyDefinition = Definition<NativeWorkflow.Any, any, any>;
/* oxlint-disable typescript/no-explicit-any -- extractors ignore the other parameter. */
type DefinitionInput<D> = D extends Definition<any, any, infer I> ? I : never;
type DefinitionSuccess<D> =
  D extends Definition<infer W, any, any> ? W["successSchema"]["Type"] : never;
type DefinitionError<D> =
  D extends Definition<infer W, any, any> ? W["errorSchema"]["Type"] : never;
type DefinitionServices<D> =
  D extends Definition<any, infer R, any> ? R : never;
/* oxlint-enable typescript/no-explicit-any */

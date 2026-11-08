import { Context, Effect, Layer } from "effect";

import type * as Artifact from "./artifact.ts";
import { DefinitionError } from "./errors.ts";
import * as ExtensionRegistry from "./extension-registry.ts";
import type * as Extension from "./extension.ts";
import * as PatchCompiler from "./patch-compiler.ts";
import { registerReports } from "./report-registry.ts";
import { selectReports } from "./report-selection.ts";
import type * as Report from "./report.ts";
import type * as Task from "./task.ts";
import {
  definitions as vaultDefinitions,
  handles as vaultHandles,
} from "./vault-state.ts";
import type * as Vault from "./vault.ts";
import type * as WorkflowSchedule from "./workflow-schedule.ts";
import * as Workflow from "./workflow.ts";

export type RegisteredTask = Task.Definition<Task.Spec, unknown>;
type Requirements<T extends readonly RegisteredTask[]> = Effect.Services<
  ReturnType<T[number]["execute"]>
>;

export interface RuntimeTask extends Task.Contract {
  readonly providerId?: string;
  readonly execute: (
    input: unknown,
    context: Task.RuntimeContext
  ) => Effect.Effect<unknown, unknown>;
}

export interface CompiledWorkflow {
  readonly definition: Workflow.Definition;
  readonly graph: Workflow.Graph;
}

export class Registry extends Context.Service<
  Registry,
  {
    readonly tasks: ReadonlyMap<string, RuntimeTask>;
    readonly reports: ReadonlyMap<string, Report.Attachment>;
    readonly vaults: ReadonlyMap<
      string,
      {
        readonly definition: Vault.Registrable;
        readonly secrets: Vault.Secrets;
        readonly backend: Vault.Backend;
      }
    >;
    readonly workflows: ReadonlyMap<string, CompiledWorkflow>;
    readonly schedules: ReadonlyMap<string, WorkflowSchedule.Definition>;
    readonly artifacts: ReadonlyMap<string, Artifact.Any>;
    readonly extensions: readonly ExtensionRegistry.Provenance[];
  }
>()("effectory/Registry") {}

export interface Application<R, E = DefinitionError> {
  readonly layer: Layer.Layer<Registry, E, R>;
  readonly provide: <ROut, E2, RIn>(
    layer: Layer.Layer<ROut, E2, RIn>
  ) => Application<Exclude<R, ROut> | RIn, E | E2>;
}

function application<R, E>(
  layer: Layer.Layer<Registry, E, R>
): Application<R, E> {
  return Object.freeze({
    layer,
    provide: <ROut, E2, RIn>(services: Layer.Layer<ROut, E2, RIn>) =>
      application(layer.pipe(Layer.provide(services))),
  });
}

const discoverSchedules = (
  declared: readonly WorkflowSchedule.Definition[],
  definitions: Map<string, Workflow.Definition>,
  pending: Workflow.Definition[]
) =>
  Effect.gen(function* () {
    const schedules = new Map<string, WorkflowSchedule.Definition>();
    if (declared.length > 128) {
      return yield* new DefinitionError({
        message: "Application exceeds 128 declared schedules",
      });
    }
    for (const schedule of declared) {
      if (schedules.has(schedule.id)) {
        return yield* new DefinitionError({
          message: `Duplicate schedule identity: ${schedule.id}`,
        });
      }
      schedules.set(schedule.id, schedule);
      const prior = definitions.get(schedule.workflow.id);
      if (prior && prior !== schedule.workflow) {
        return yield* new DefinitionError({
          message: `Noncanonical workflow: ${schedule.workflow.id}`,
        });
      }
      if (!prior) {
        definitions.set(schedule.workflow.id, schedule.workflow);
        pending.push(schedule.workflow);
      }
    }
    return schedules;
  });

function discoverVaults<R>(
  declared: readonly Vault.Registrable[],
  services: Context.Context<R>
) {
  return Effect.gen(function* () {
    const vaults = new Map<
      string,
      {
        readonly definition: Vault.Registrable;
        readonly secrets: Vault.Secrets;
        readonly backend: Vault.Backend;
      }
    >();
    if (declared.length > 128) {
      return yield* new DefinitionError({
        message: "At most 128 vaults may be registered",
      });
    }
    for (const definition of declared) {
      const metadata = vaultDefinitions.get(definition);
      const handle = Context.getOrUndefined(
        services,
        Context.Service<object>(definition.key)
      );
      const owned = handle && vaultHandles.get(handle);
      if (
        !metadata ||
        !owned ||
        owned.definition !== definition ||
        vaults.has(definition.id)
      ) {
        return yield* new DefinitionError({
          message: `Missing, duplicate or noncanonical vault: ${definition.id}`,
        });
      }
      vaults.set(definition.id, {
        backend: owned.backend,
        definition,
        secrets: metadata.secrets,
      });
    }
    return vaults;
  });
}

export function make<
  const T extends readonly RegisteredTask[] = readonly [],
  const X extends readonly Extension.Use[] = readonly [],
  const V extends readonly Vault.Registrable[] = readonly [],
>(spec: {
  readonly tasks?: T;
  readonly reports?: readonly Report.Attachment[];
  readonly workflows?: readonly Workflow.Definition[];
  readonly schedules?: readonly WorkflowSchedule.Definition[];
  readonly artifacts?: readonly Artifact.Any[];
  readonly extensions?: X;
  readonly vaults?: V;
}): Application<
  Requirements<T> | Extension.Requirements<X[number]> | V[number]
> {
  const declaredReports = Object.freeze([...(spec.reports ?? [])]);
  const declaredSchedules = spec.schedules ?? [];
  const declaredVaults = spec.vaults ?? [];
  const build = Effect.gen(function* () {
    const services = yield* Effect.context<
      Requirements<T> | Extension.Requirements<X[number]> | V[number]
    >();
    const vaults = yield* discoverVaults(declaredVaults, services);
    const resolved = yield* ExtensionRegistry.resolve(
      spec.extensions ?? [],
      spec.tasks ?? [],
      spec.workflows ?? [],
      spec.artifacts ?? []
    );
    const tasks = new Map<string, RuntimeTask>();
    for (const task of resolved.tasks.values()) {
      tasks.set(task.id, {
        ...task,
        // The heterogeneous registry erases R only after make has accumulated
        // every task's service requirements into its public Layer signature.
        execute: (input, context) =>
          // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- user code loaded at runtime has an unknown error type
          task
            .execute(input, context)
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the checker cannot relate this erased generic
            .pipe(Effect.provideContext(services as Context.Context<unknown>)),
      });
    }
    const workflows = new Map<string, CompiledWorkflow>();
    const pending = [...resolved.workflows];
    const definitions = new Map(
      pending.map((definition) => [definition.id, definition])
    );
    if (definitions.size !== pending.length) {
      return yield* new DefinitionError({
        message: "Duplicate workflow identity",
      });
    }
    const schedules = yield* discoverSchedules(
      declaredSchedules,
      definitions,
      pending
    );
    for (const definition of pending) {
      const graph = yield* PatchCompiler.apply(
        definition,
        yield* definition.build,
        resolved.patches
      );
      const declared = Workflow.allNodes(graph);
      if (declared.length > 10_000) {
        return yield* new DefinitionError({
          message: "Application graph exceeds 10000 declared nodes",
        });
      }
      for (const node of declared) {
        if (node.kind === "Workflow") {
          const prior = definitions.get(node.workflow.id);
          if (prior && prior !== node.workflow) {
            return yield* new DefinitionError({
              message: `Noncanonical workflow: ${node.workflow.id}`,
            });
          }
          if (!prior) {
            if (pending.length >= 1000) {
              return yield* new DefinitionError({
                message: "Too many linked workflows",
              });
            }
            definitions.set(node.workflow.id, node.workflow);
            pending.push(node.workflow);
          }
        }
        if (node.kind === "Task") {
          const task = tasks.get(node.task.id);
          if (!task || task.spec !== node.task.spec) {
            return yield* new DefinitionError({
              message: `Missing or noncanonical task contract: ${node.task.id}`,
            });
          }
        }
      }
      workflows.set(definition.id, { definition, graph });
    }
    for (const patch of resolved.patches) {
      if (!workflows.has(patch.binding.workflow.id)) {
        return yield* new DefinitionError({
          message: `Missing patch workflow: ${patch.binding.workflow.id}`,
        });
      }
    }
    yield* Effect.try({
      catch: (cause) =>
        cause instanceof DefinitionError
          ? cause
          : new DefinitionError({ message: "Workflow validation failed" }),
      try: () => {
        const done = new Set<string>();
        const visiting = new Set<string>();
        const visit = (id: string) => {
          if (visiting.has(id)) {
            throw new DefinitionError({ message: `Recursive workflow: ${id}` });
          }
          if (done.has(id)) {
            return;
          }
          visiting.add(id);
          const workflow = workflows.get(id);
          if (!workflow) {
            throw new DefinitionError({ message: `Missing workflow: ${id}` });
          }
          for (const node of Workflow.allNodes(workflow.graph)) {
            if (node.kind === "Workflow") {
              visit(node.workflow.id);
            }
          }
          visiting.delete(id);
          done.add(id);
        };
        for (const id of workflows.keys()) {
          visit(id);
        }
      },
    });
    const reports = yield* Effect.try({
      catch: (cause) =>
        cause instanceof DefinitionError
          ? cause
          : new DefinitionError({ message: "Report registration failed" }),
      try: () => {
        const registered = registerReports(declaredReports, tasks, workflows);
        for (const schedule of schedules.values()) {
          selectReports(
            { reports: registered, workflows },
            "workflow",
            schedule.workflow.id,
            schedule.reportSelection
          );
        }
        return registered;
      },
    });
    return {
      artifacts: resolved.artifacts,
      extensions: resolved.extensions,
      reports,
      schedules,
      tasks,
      vaults,
      workflows,
    };
  });
  return application(Layer.effect(Registry, build));
}

import { Effect, Schema } from "effect";

import type { RegisteredTask } from "./application.ts";
import type * as Artifact from "./artifact.ts";
import { identifier } from "./boundary.ts";
import { DefinitionError, definitionError } from "./errors.ts";
import type * as Task from "./task.ts";
import type * as WorkflowPatch from "./workflow-patch.ts";
import type * as Workflow from "./workflow.ts";

export type TaskRecord = Readonly<Record<string, RegisteredTask>>;
export type WorkflowRecord = Readonly<Record<string, Workflow.Definition>>;
export type ArtifactRecord = Readonly<Record<string, Artifact.Artifact>>;
export type Implementation = RegisteredTask & { readonly providerId: string };
type Empty = Readonly<Record<never, never>>;

export interface Definition<
  T extends TaskRecord = TaskRecord,
  I extends readonly Implementation[] = readonly Implementation[],
  W extends WorkflowRecord = WorkflowRecord,
  A extends ArtifactRecord = ArtifactRecord,
  P extends readonly WorkflowPatch.Definition[] =
    readonly WorkflowPatch.Definition[],
> {
  readonly kind: "Extension";
  readonly id: string;
  readonly version: string;
  readonly tasks: T;
  readonly implementations: I;
  readonly workflows: W;
  readonly artifacts: A;
  readonly patches: P;
}

const definitions = new WeakSet<object>();
const names = (record: Readonly<Record<string, unknown>>) => {
  for (const name of Object.keys(record)) {
    if (
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ||
      ["__proto__", "constructor", "prototype"].includes(name)
    ) {
      throw new DefinitionError({
        message: `Invalid extension export name: ${name}`,
      });
    }
  }
};

export function make<
  const T extends TaskRecord = Empty,
  const I extends readonly Implementation[] = readonly [],
  const W extends WorkflowRecord = Empty,
  const A extends ArtifactRecord = Empty,
  const P extends readonly WorkflowPatch.Definition[] = readonly [],
>(spec: {
  readonly id: string;
  readonly version: string;
  readonly tasks?: T;
  readonly implementations?: I;
  readonly workflows?: W;
  readonly artifacts?: A;
  readonly patches?: P;
}): Definition<T, I, W, A, P> {
  identifier(spec.id);
  if (
    !spec.id.includes("/") ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(spec.version)
  ) {
    throw new DefinitionError({
      message: "Extensions require a namespaced ID and semantic version",
    });
  }
  names(spec.tasks ?? {});
  names(spec.workflows ?? {});
  names(spec.artifacts ?? {});
  // The optional generic contributions default to empty records/tuples. The
  // assertions retain the exact named exports supplied by the caller.
  const definition: Definition<T, I, W, A, P> = Object.freeze({
    artifacts: Object.freeze({ ...spec.artifacts }) as A,
    id: spec.id,
    implementations: Object.freeze([
      ...(spec.implementations ?? []),
    ]) as unknown as I,
    kind: "Extension",
    patches: Object.freeze([...(spec.patches ?? [])]) as unknown as P,
    tasks: Object.freeze({ ...spec.tasks }) as T,
    version: spec.version,
    workflows: Object.freeze({ ...spec.workflows }) as W,
  });
  definitions.add(definition);
  return definition;
}

export const BindingSchema = Schema.Struct({
  after: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMaxLength(32))
  ),
  at: Schema.Array(
    Schema.Union([
      Schema.String,
      Schema.Struct({ branch: Schema.Literals(["onTrue", "onFalse"]) }),
      Schema.Struct({ item: Schema.Literal(true) }),
    ])
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  id: Schema.NonEmptyString,
  use: Schema.NonEmptyString,
  workflow: Schema.Struct({
    id: Schema.NonEmptyString,
    version: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
});
export type Binding = typeof BindingSchema.Type;
export interface Options<D extends Definition = Definition> {
  readonly implementations?: readonly D["implementations"][number]["providerId"][];
  readonly patches?: readonly Binding[];
}

export interface Contracts<D extends Definition> {
  readonly id: string;
  readonly version: string;
  readonly tasks: {
    readonly [K in keyof D["tasks"]]: Task.Contract<D["tasks"][K]["spec"]>;
  };
  readonly workflows: D["workflows"];
  readonly artifacts: D["artifacts"];
}
export interface Installed<
  D extends Definition = Definition,
  C extends Contracts<D> = Contracts<D>,
> extends Contracts<D> {
  readonly kind: "InstalledExtension";
  readonly digest: string;
  /** Additional public contract exports, including service identities. */
  readonly exports: C;
  /** Generated bindings load the retained implementation lazily. */
  readonly load: () => Promise<D>;
}

/** Used by generated bindings; importing a contract does not import its handler. */
export function installed<
  D extends Definition,
  C extends Contracts<NoInfer<D>>,
>(contracts: C, loader: () => Promise<D>, digest: string): Installed<D, C> {
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new DefinitionError({
      message: "Invalid installed extension digest",
    });
  }
  return Object.freeze({
    ...contracts,
    digest,
    exports: contracts,
    kind: "InstalledExtension",
    load: loader,
  });
}

export interface Use<
  D extends Definition = Definition,
  O extends Options<D> = Options<D>,
> {
  readonly extension: D | Installed<D>;
  readonly selection: O;
}

export function use<D extends Definition>(
  extension: D | Installed<D>
): Use<D, Empty>;
export function use<D extends Definition, const O extends Options<D>>(
  extension: D | Installed<D>,
  selection: O
): Use<D, NoInfer<O>>;
export function use<D extends Definition, const O extends Options<D> = Empty>(
  extension: D | Installed<D>,
  selection?: O
): Use<D, O> {
  for (const binding of selection?.patches ?? []) {
    Schema.decodeUnknownSync(BindingSchema)(binding, {
      onExcessProperty: "error",
    });
    identifier(binding.id);
  }
  // Selection is declarative data. Keep caller mutation from changing an
  // already constructed Application or its recorded provider provenance.
  const selected = {
    ...selection,
    ...(selection?.implementations
      ? { implementations: Object.freeze([...selection.implementations]) }
      : {}),
    ...(selection?.patches
      ? {
          patches: Object.freeze(
            selection.patches.map((binding) =>
              Object.freeze({
                ...binding,
                at: Object.freeze(
                  binding.at.map((segment) =>
                    typeof segment === "string"
                      ? segment
                      : Object.freeze({ ...segment })
                  )
                ),
                workflow: Object.freeze({ ...binding.workflow }),
                ...(binding.after
                  ? { after: Object.freeze([...binding.after]) }
                  : {}),
              })
            )
          ),
        }
      : {}),
  };
  return Object.freeze({ extension, selection: Object.freeze(selected) as O });
}

type TaskServices<T> = T extends RegisteredTask
  ? Effect.Services<ReturnType<T["execute"]>>
  : never;
type SelectedIds<O> = "implementations" extends keyof O
  ? NonNullable<O["implementations"]> extends readonly (infer Id)[]
    ? Id
    : never
  : never;
type DefinitionOf<E> = E extends {
  readonly load: () => Promise<infer D extends Definition>;
}
  ? D
  : E extends Definition
    ? E
    : never;
type RequirementsOf<D extends Definition, O> =
  | TaskServices<D["tasks"][keyof D["tasks"]]>
  | TaskServices<
      Extract<
        D["implementations"][number],
        { readonly providerId: SelectedIds<O> }
      >
    >;
export type Requirements<U> = U extends {
  readonly extension: infer E;
  readonly selection: infer O;
}
  ? RequirementsOf<DefinitionOf<E>, O>
  : never;

function sameContracts(expected: Installed, actual: Definition) {
  if (expected.id !== actual.id || expected.version !== actual.version) {
    throw new DefinitionError({
      message: "Installed extension identity disagrees with its contracts",
    });
  }
  for (const kind of ["tasks", "workflows", "artifacts"] as const) {
    if (
      JSON.stringify(Object.keys(expected[kind]).toSorted()) !==
      JSON.stringify(Object.keys(actual[kind]).toSorted())
    ) {
      throw new DefinitionError({
        message: `Installed ${kind} exports disagree`,
      });
    }
  }
  for (const [name, task] of Object.entries(expected.tasks)) {
    if (task.spec !== actual.tasks[name]?.spec) {
      throw new DefinitionError({
        message: `Noncanonical installed task contract: ${name}`,
      });
    }
  }
  for (const [name, workflow] of Object.entries(expected.workflows)) {
    if (workflow !== actual.workflows[name]) {
      throw new DefinitionError({
        message: `Noncanonical installed workflow: ${name}`,
      });
    }
  }
  for (const [name, artifact] of Object.entries(expected.artifacts)) {
    if (artifact !== actual.artifacts[name]) {
      throw new DefinitionError({
        message: `Noncanonical installed artifact: ${name}`,
      });
    }
  }
}

/** Application compilation loads only explicitly included extensions. */
export function load(
  selection: Use
): Effect.Effect<Definition, DefinitionError> {
  const { extension } = selection;
  const loaded =
    extension.kind === "Extension"
      ? Effect.succeed(extension)
      : Effect.tryPromise({ catch: definitionError, try: extension.load });
  return loaded.pipe(
    Effect.flatMap((definition) =>
      Effect.try({
        catch: definitionError,
        try: () => {
          if (!definitions.has(definition)) {
            throw new DefinitionError({
              message:
                "Extension must export an Extension.make definition using the host SDK",
            });
          }
          if (extension.kind === "InstalledExtension") {
            sameContracts(extension, definition);
          }
          return definition;
        },
      })
    )
  );
}

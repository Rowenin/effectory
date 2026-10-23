/* oxlint-disable max-classes-per-file -- the CLI failure and the Runtime service. */
/**
 * Loading the collection and providing the runtime every command runs in:
 * the collection's Layers, `State` over SQLite, and the `Engine`.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Action, Collection, Engine, State } from "@effectory/core";
import type { Workflow } from "@effectory/core";
import { Context, Data, Effect, Layer, Option } from "effect";
import { Command, Flag } from "effect/cli";

import { revision } from "./revision.ts";

/** A user-facing failure: printed without a stack, exit code 1. */
export class CliFailure extends Data.TaggedError("CliFailure")<{
  readonly message: string;
}> {}

/** The root command, holding the flags every subcommand shares. */
export const root = Command.make("effectory").pipe(
  Command.withDescription(
    "Run, inspect, and serve the automations of an Effectory collection."
  ),
  Command.withSharedFlags({
    collection: Flag.String("collection").pipe(
      Flag.withDescription(
        "Collection root file or directory (default: ./effectory.ts)"
      ),
      Flag.optional
    ),
    state: Flag.String("state").pipe(
      Flag.withDescription(
        "State database (default: $EFFECTORY_HOME/state.sqlite, EFFECTORY_HOME defaults to ~/.effectory)"
      ),
      Flag.optional
    ),
  })
);

export interface Loaded {
  readonly collection: Collection.Any;
  /** Absolute path of the collection root file. */
  readonly rootFile: string;
  readonly revision: string;
  readonly stateFile: string;
}

export class Runtime extends Context.Service<Runtime, Loaded>()(
  "effectory/cli/Runtime"
) {}

/** The collection root file for `--collection` (a file or directory). */
export const rootFileOf = (given: string | undefined, cwd: string): string => {
  const resolved = path.resolve(cwd, given ?? ".");
  return existsSync(resolved) && statSync(resolved).isDirectory()
    ? path.join(resolved, "effectory.ts")
    : resolved;
};

/** `--state`, else `$EFFECTORY_HOME/state.sqlite`, else `~/.effectory/state.sqlite`. */
export const stateFileOf = (given: string | undefined, cwd: string): string => {
  if (given !== undefined) {
    return path.resolve(cwd, given);
  }
  const home = process.env.EFFECTORY_HOME;
  return path.join(
    home === undefined || home === ""
      ? path.join(homedir(), ".effectory")
      : path.resolve(cwd, home),
    "state.sqlite"
  );
};

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Import the collection root and check its default export. */
export const importCollection = Effect.fn("importCollection")(
  function* importCollection(rootFile: string) {
    if (!existsSync(rootFile)) {
      return yield* new CliFailure({
        message: `No collection root at ${rootFile}; run in a directory with effectory.ts or pass --collection`,
      });
    }
    const module = yield* Effect.tryPromise({
      catch: (error) =>
        new CliFailure({
          message: `Could not load ${rootFile}: ${messageOf(error)}`,
        }),
      try: () =>
        import(pathToFileURL(rootFile).href) as Promise<{
          readonly default?: unknown;
        }>,
    });
    if (!Collection.isCollection(module.default)) {
      return yield* new CliFailure({
        message: `${rootFile} must default-export Collection.make(...)`,
      });
    }
    return module.default;
  }
);

/** Load the collection named by the shared flags and compute its revision. */
export const load = Effect.gen(function* loadCollection() {
  const flags = yield* root;
  const cwd = process.cwd();
  const rootFile = rootFileOf(Option.getOrUndefined(flags.collection), cwd);
  const collection = yield* importCollection(rootFile);
  const computed = yield* Effect.try({
    catch: (error) =>
      new CliFailure({
        message: `Could not compute the revision: ${messageOf(error)}`,
      }),
    try: () => revision(rootFile),
  });
  return {
    collection,
    revision: computed,
    rootFile,
    stateFile: stateFileOf(Option.getOrUndefined(flags.state), cwd),
  } satisfies Loaded;
});

/** What loading needs: the parsed root flags. */
type LoadContext =
  typeof load extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

/**
 * Provide `Runtime`, `State`, `Engine`, and the collection's Layers.
 * Requirements of collection workflows are erased: the collection layer
 * provides them.
 */
export const withRuntime = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | CliFailure, LoadContext | Collection.Platform> =>
  Effect.gen(function* provideRuntime() {
    const loaded = yield* load;
    const state = State.layer(loaded.stateFile);
    const layer = Layer.mergeAll(
      Engine.layer,
      loaded.collection.layer as Layer.Layer<
        never,
        unknown,
        Collection.Platform
      >,
      Layer.succeed(Runtime, loaded)
    ).pipe(Layer.provideMerge(state));
    return yield* Effect.provide(effect, layer);
  }) as never;

/** Find a run of this collection by id or unique id prefix. */
export const findRun = Effect.fn("findRun")(function* findRun(id: string) {
  const { collection } = yield* Runtime;
  const state = yield* State.State;
  const exact = yield* state.getRun(id);
  if (exact !== undefined && exact.collection === collection.name) {
    return exact;
  }
  const runs = yield* state.listRuns({
    collection: collection.name,
    limit: 1_000_000,
  });
  const matches = runs.filter((run) => run.id.startsWith(id));
  if (matches.length === 1) {
    return matches[0] as State.RunRow;
  }
  return yield* new CliFailure({
    message:
      matches.length === 0
        ? `No run ${id} in collection ${collection.name}`
        : `Run id ${id} is ambiguous: ${matches.map((run) => run.id).join(", ")}`,
  });
});

/** The workflow a run ran: a collection workflow, or an Action run by `action run`. */
export const workflowOf = Effect.fn("workflowOf")(function* workflowOf(
  name: string
) {
  const { collection } = yield* Runtime;
  const workflow = collection.workflows.find(
    (candidate) => candidate.name === name
  );
  if (workflow !== undefined) {
    return workflow;
  }
  const action = collection.actions.find(
    (candidate) => candidate.type === name
  );
  if (action !== undefined) {
    return Action.toWorkflow(action) as Workflow.Any;
  }
  return yield* new CliFailure({
    message: `No workflow or Action ${name} in collection ${collection.name}`,
  });
});

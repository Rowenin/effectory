/** `effectory describe` and `effectory serve`. */
import { Describe, Engine, SecretStore, State, Trigger } from "@effectory/core";
import { Console, Deferred, Effect, Fiber, Layer, Option } from "effect";
import { Command, Flag } from "effect/cli";

import { printJson, renderDescription } from "../output.ts";
import { CliFailure, Runtime, load, withRuntime } from "../runtime.ts";

export const describe = Command.make(
  "describe",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print the description with JSON Schemas"),
      Flag.withDefault(false)
    ),
  },
  (flags) =>
    Effect.gen(function* describeCollection() {
      const { collection } = yield* load;
      const described = Describe.describe(collection);
      return yield* flags.json
        ? printJson(described)
        : Console.log(renderDescription(described));
    })
).pipe(
  Command.withDescription(
    "List the collection's workflows, Actions, Resources, Targets, and Triggers"
  )
);

/**
 * Start a run in the background and return its id once it is admitted. The
 * engine assigns run ids, so this engine's State reports the admitted run.
 */
const dispatcher = Effect.gen(function* makeDispatcher() {
  const { collection, revision } = yield* Runtime;
  const state = yield* State.State;
  const scope = yield* Effect.scope;
  // oxlint-disable-next-line typescript/no-explicit-any -- the collection layer provides every workflow's services.
  const context = yield* Effect.context<any>();
  const dispatch: Trigger.Dispatch = (workflow, input, meta) =>
    Effect.gen(function* dispatchRun() {
      const admitted = yield* Deferred.make<string, CliFailure>();
      const engine = yield* Engine.make.pipe(
        Effect.provideService(State.State, {
          ...state,
          admitRun: (row) =>
            state
              .admitRun(row)
              .pipe(
                Effect.tap((result) =>
                  result.admitted
                    ? Deferred.succeed(admitted, result.run.id)
                    : Effect.void
                )
              ),
        })
      );
      const fiber = yield* engine
        .run(workflow, input, {
          collection: collection.name,
          revision,
          ...(meta.target === undefined ? {} : { target: meta.target }),
        })
        .pipe(
          Effect.tap((summary) =>
            Console.log(
              `${meta.trigger}: run ${summary.run.id} of ${workflow.name} ${summary.run.status}`
            )
          ),
          Effect.tapError((error) =>
            Console.error(
              `${meta.trigger}: ${error instanceof Error ? error.message : String(error)}`
            )
          ),
          Effect.provideContext(context),
          Effect.forkIn(scope)
        );
      return yield* Effect.raceFirst(
        Deferred.await(admitted),
        Fiber.join(fiber).pipe(Effect.andThen(Deferred.await(admitted)))
      );
    });
  return dispatch;
});

export const serve = Command.make(
  "serve",
  {
    hostname: Flag.String("hostname").pipe(Flag.optional),
    port: Flag.Int("port").pipe(
      Flag.withDescription("Port for webhooks (0 picks a free port)"),
      Flag.withDefault(8787)
    ),
  },
  (flags) =>
    withRuntime(
      Effect.scoped(
        Effect.gen(function* serveTriggers() {
          const { collection } = yield* Runtime;
          if (collection.triggers.length === 0) {
            return yield* new CliFailure({
              message: `Collection ${collection.name} declares no triggers`,
            });
          }
          const dispatch = yield* dispatcher;
          const secrets = yield* Effect.serviceOption(SecretStore);
          const server = yield* Trigger.serve(collection.triggers, {
            dispatch,
            port: flags.port,
            ...(Option.isSome(flags.hostname)
              ? { hostname: flags.hostname.value }
              : {}),
          }).pipe(
            Effect.provide(
              Option.isSome(secrets)
                ? Layer.succeed(SecretStore, secrets.value)
                : SecretStore.env
            )
          );
          const lines = collection.triggers.map((trigger) =>
            trigger._tag === "Schedule"
              ? `  schedule ${trigger.cron} -> ${trigger.name}`
              : `  POST ${server.url.replace(/\/$/u, "")}${trigger.route} -> ${trigger.name}`
          );
          yield* Console.log(
            [`Serving ${collection.name} on ${server.url}`, ...lines].join("\n")
          );
          return yield* Effect.never;
        })
      )
    )
).pipe(
  Command.withDescription(
    "Serve the collection's webhook and schedule triggers"
  )
);

/** `effectory data latest | versions | query` and `effectory resource list | delete`. */
import { Data, Resource, State } from "@effectory/core";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { printJson, renderRecords, renderResources } from "../output.ts";
import { CliFailure, Runtime, withRuntime } from "../runtime.ts";

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON"),
  Flag.withDefault(false)
);
const scope = Flag.String("scope").pipe(
  Flag.withDescription("The scope the records belong to")
);
const fqn = Argument.String("fqn");

const latest = Command.make("latest", { fqn, json, scope }, (flags) =>
  withRuntime(
    Effect.gen(function* latestRecord() {
      const { collection } = yield* Runtime;
      const state = yield* State.State;
      const [record] = yield* state.records({
        collection: collection.name,
        fqn: flags.fqn,
        limit: 1,
        scope: flags.scope,
      });
      if (record === undefined) {
        return yield* new CliFailure({
          message: `No record ${flags.fqn} in scope ${flags.scope}`,
        });
      }
      return yield* flags.json
        ? printJson(record)
        : Console.log(
            `${record.kind} ${record.fqn} (run ${record.runId}, ${new Date(record.createdAt).toISOString()}):\n${JSON.stringify(record.value, null, 2)}`
          );
    })
  )
).pipe(Command.withDescription("Print the newest record of an FQN in a scope"));

const limit = (fallback: number) =>
  Flag.Int("limit").pipe(
    Flag.withDescription("Most records, newest first"),
    Flag.withDefault(fallback)
  );

const versions = Command.make(
  "versions",
  { fqn, json, limit: limit(10), scope },
  (flags) =>
    withRuntime(
      Effect.gen(function* recordVersions() {
        const { collection } = yield* Runtime;
        const state = yield* State.State;
        const records = yield* state.records({
          collection: collection.name,
          fqn: flags.fqn,
          limit: flags.limit,
          scope: flags.scope,
        });
        return yield* flags.json
          ? printJson(records)
          : Console.log(renderRecords(records));
      })
    )
).pipe(Command.withDescription("List stored versions of an FQN in a scope"));

const query = Command.make(
  "query",
  {
    fqn: Flag.String("fqn").pipe(Flag.optional),
    json,
    kind: Flag.String("kind").pipe(
      Flag.withDescription(
        "Record kind: an Action or Resource type, AssertResult, Report"
      ),
      Flag.optional
    ),
    limit: limit(50),
    scope: Flag.String("scope").pipe(Flag.optional),
    since: Flag.String("since").pipe(
      Flag.withDescription("7d, 12h, 30m, 45s, or an ISO date"),
      Flag.optional
    ),
    where: Flag.String("where").pipe(
      Flag.withDescription(
        "Filter on the value: `field op value [and ...]`, ops = != < <= > >="
      ),
      Flag.optional
    ),
  },
  (flags) =>
    withRuntime(
      Effect.gen(function* queryRecords() {
        const { collection } = yield* Runtime;
        const state = yield* State.State;
        const where = Option.isSome(flags.where)
          ? yield* Data.parseWhere(flags.where.value)
          : undefined;
        const since = Option.isSome(flags.since)
          ? yield* Data.parseSince(flags.since.value)
          : undefined;
        const records = yield* state.records({
          collection: collection.name,
          limit: flags.limit,
          ...(Option.isSome(flags.fqn) ? { fqn: flags.fqn.value } : {}),
          ...(Option.isSome(flags.kind) ? { kind: flags.kind.value } : {}),
          ...(Option.isSome(flags.scope) ? { scope: flags.scope.value } : {}),
          ...(since === undefined ? {} : { since }),
          ...(where === undefined ? {} : { where }),
        });
        return yield* flags.json
          ? printJson(records)
          : Console.log(renderRecords(records));
      })
    )
).pipe(Command.withDescription("Query records across runs and scopes"));

export const data = Command.make("data").pipe(
  Command.withDescription(
    "Read the records Actions, Resources, and Asserts write"
  ),
  Command.withSubcommands([latest, versions, query])
);

const resourceList = Command.make(
  "list",
  {
    json,
    scope: Flag.String("scope").pipe(Flag.optional),
  },
  (flags) =>
    withRuntime(
      Effect.gen(function* listResources() {
        const { collection } = yield* Runtime;
        const state = yield* State.State;
        const resources = yield* state.listResources({
          collection: collection.name,
          ...(Option.isSome(flags.scope) ? { scope: flags.scope.value } : {}),
        });
        return yield* flags.json
          ? printJson(resources)
          : Console.log(renderResources(resources));
      })
    )
).pipe(Command.withDescription("List resource state rows"));

const resourceDelete = Command.make(
  "delete",
  { fqn, scope: Flag.String("scope") },
  (flags) =>
    withRuntime(
      Effect.gen(function* deleteResource() {
        const { collection } = yield* Runtime;
        yield* Resource.destroy({
          collection: collection.name,
          fqn: flags.fqn,
          scope: flags.scope,
        });
        return yield* Console.log(
          `Deleted ${flags.fqn} in scope ${flags.scope}`
        );
      })
    )
).pipe(
  Command.withDescription(
    "Delete a resource's object through its provider, then its state row"
  )
);

export const resource = Command.make("resource").pipe(
  Command.withDescription("Inspect and delete resources"),
  Command.withSubcommands([resourceList, resourceDelete])
);

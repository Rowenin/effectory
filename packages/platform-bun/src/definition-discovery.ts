import { DefinitionListRequest } from "@effectory/runtime/history-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import { Catalog } from "./catalog.ts";
import { HostStore } from "./host-store.ts";

export const listDefinitions = (
  kind: "task" | "workflow",
  value: typeof DefinitionListRequest.Type,
  principal: string
) =>
  Effect.gen(function* () {
    const catalog = yield* Catalog;
    const store = yield* HostStore;
    const { cursor, ...query } = yield* Schema.decodeUnknownEffect(
      DefinitionListRequest
    )(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(
        () =>
          new OperationError({
            code: "InvalidInput",
            message: "Invalid discovery query",
          })
      )
    );
    const limit = query.limit ?? 50;
    const scope = {
      kind: `definitions/${kind}`,
      principal,
      query: { ...query, limit },
    };
    const token = yield* Effect.try({
      catch: (error) =>
        error instanceof OperationError
          ? error
          : new OperationError({
              code: "InvalidInput",
              message: "Invalid discovery cursor",
            }),
      try: () => store.pagination.read(scope, cursor),
    });
    const revision =
      token === null
        ? query.revision
        : yield* Schema.decodeUnknownEffect(Schema.String)(token.snapshot).pipe(
            Effect.mapError(
              () =>
                new OperationError({
                  code: "InvalidInput",
                  message: "Invalid discovery snapshot",
                })
            )
          );
    const application = yield* catalog.get(revision);
    const definitions =
      kind === "task"
        ? application.registry.tasks
        : application.registry.workflows;
    if (definitions.size > 10_000) {
      return yield* new OperationError({
        code: "LimitExceeded",
        message: "Application discovery exceeds 10000 definitions",
      });
    }
    const after =
      token === null
        ? ""
        : yield* Schema.decodeUnknownEffect(Schema.String)(token.position).pipe(
            Effect.mapError(
              () =>
                new OperationError({
                  code: "InvalidInput",
                  message: "Invalid discovery position",
                })
            )
          );
    const summaries =
      kind === "task"
        ? [...application.registry.tasks.values()].map((task) => ({
            id: task.id,
            kind,
            version: task.spec.version,
          }))
        : [...application.registry.workflows.values()].map((workflow) => ({
            id: workflow.definition.id,
            kind,
            version: workflow.definition.spec.version,
          }));
    const matching = summaries
      .filter(
        ({ id }) =>
          id > after &&
          (query.search === undefined ||
            id.toLowerCase().includes(query.search.toLowerCase())) &&
          (query.namespace === undefined ||
            id === query.namespace ||
            id.startsWith(`${query.namespace}/`))
      )
      .toSorted((left, right) =>
        left.id < right.id ? -1 : Number(left.id > right.id)
      );
    const items = matching.slice(0, limit);
    const last = items.at(-1);
    return {
      cursor:
        matching.length > limit && last
          ? store.pagination.write(
              scope,
              application.revision,
              last.id,
              token?.expires ?? Date.now() + 3_600_000
            )
          : null,
      items,
      revision: application.revision,
    };
  }).pipe(Effect.scoped);

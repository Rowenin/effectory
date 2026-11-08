import { Effect, Layer, Schema } from "effect";
import { absurd } from "effect/Function";

import type * as Artifact from "./artifact.ts";
import { decode } from "./boundary.ts";
import { TaskRuntimeError } from "./errors.ts";
import { checkJsonBudget } from "./json-budget.ts";
import {
  Event,
  EventRequest,
  History,
  InvocationItem,
  Outcome,
  PageRequest,
  Source,
} from "./report-history.ts";
import type { HistoryService, Target } from "./report-history.ts";
import { sources, targetKey } from "./report-state.ts";
import type * as Tag from "./tag.ts";
import * as Task from "./task.ts";

function invalid(message: string) {
  return new TaskRuntimeError({
    code: "InvalidBoundary",
    message: `Invalid report fixture: ${message}`,
  });
}
const attempt = <A>(field: string, body: () => A) =>
  Effect.try({
    catch: (error) =>
      error instanceof TaskRuntimeError ? error : invalid(field),
    try: body,
  });

function page<A>(
  items: readonly A[],
  request: PageRequest,
  prefix: string,
  budget: number
) {
  const position = request.cursor?.slice(prefix.length) ?? "0";
  if (
    (request.cursor !== undefined && !request.cursor.startsWith(prefix)) ||
    !/^(?:0|[1-9][0-9]*)$/u.test(position)
  ) {
    throw invalid("cursor");
  }
  const offset = Number(position);
  if (!Number.isSafeInteger(offset) || offset > items.length) {
    throw invalid("cursor");
  }
  const selected: A[] = [];
  let index = offset;
  for (
    ;
    index < items.length && selected.length < (request.limit ?? 100);
    index += 1
  ) {
    const item = items[index];
    if (item === undefined) {
      throw invalid("sparse page");
    }
    selected.push(structuredClone(item));
    if (
      new TextEncoder().encode(
        JSON.stringify({
          cursor: `${prefix}${index + 1}`,
          items: selected,
          snapshot: items.length,
        })
      ).byteLength > budget
    ) {
      selected.pop();
      break;
    }
  }
  if (index < items.length && selected.length === 0) {
    throw new TaskRuntimeError({
      code: "LimitExceeded",
      message: "Report fixture item exceeds the history page budget",
    });
  }
  return {
    cursor: index < items.length ? `${prefix}${index}` : null,
    items: selected,
    snapshot: items.length,
  };
}

export function test<S extends Task.Spec, R>(
  task: Task.Definition<S, R>,
  fixtures: {
    readonly artifacts?: readonly Artifact.Fixture[];
    readonly source: NoInfer<S["input"]["Type"]>;
    readonly outcome: Outcome<Schema.Json, Schema.Json>;
    readonly invocations?: readonly InvocationItem[];
    readonly events?: readonly (typeof Event.Type)[];
    readonly tags?: Tag.Input;
  }
) {
  return Effect.suspend(() =>
    Effect.gen(function* () {
      const source = yield* attempt("source", () =>
        decode(Source, structuredClone(fixtures.source))
      );
      const outcome = yield* attempt("outcome", () => {
        const value = decode(Outcome, structuredClone(fixtures.outcome));
        let status: Source["status"] = "Failed";
        switch (value._tag) {
          case "Succeeded": {
            checkJsonBudget(value.value);
            status = "Succeeded";
            break;
          }
          case "DomainFailure": {
            checkJsonBudget(value.error);
            break;
          }
          case "Stopped": {
            checkJsonBudget(value.detail);
            ({ status } = value);
            break;
          }
          case "Failure": {
            checkJsonBudget(value.detail);
            break;
          }
          default: {
            absurd(value);
          }
        }
        if (status !== source.status) {
          throw invalid("source.status disagrees with outcome");
        }
        return value;
      });
      const invocations = yield* attempt("invocations", () =>
        decode(
          Schema.Array(InvocationItem).check(Schema.isMaxLength(10_000)),
          structuredClone(fixtures.invocations ?? [])
        )
      );
      const events = yield* attempt("events", () => {
        const values = decode(
          Schema.Array(Event).check(Schema.isMaxLength(10_000)),
          structuredClone(fixtures.events ?? [])
        );
        let previous = 0;
        for (const event of values) {
          if (event.runId !== source.runId || event.sequence <= previous) {
            throw invalid(
              "events must belong to the source and have increasing positive sequences"
            );
          }
          previous = event.sequence;
        }
        return values;
      });
      let active = true;
      const prefix = `report-test/${crypto.randomUUID()}/`;
      const read = <A>(field: string, body: () => A) =>
        attempt(field, () => {
          if (!active) {
            throw invalid("invocation closed");
          }
          return body();
        });
      // Runtime canonical-target checks and codec decoding establish the
      // overloads' dependent result.
      function outcomeRead(): Effect.Effect<
        Outcome<Schema.Json, Schema.Json>,
        TaskRuntimeError
      >;
      function outcomeRead<T extends Target>(
        target: T
      ): Effect.Effect<
        Outcome<T["successSchema"]["Type"], T["errorSchema"]["Type"]>,
        TaskRuntimeError
      >;
      function outcomeRead(target?: Target) {
        return read("outcome target or codec", () => {
          if (!target) {
            return structuredClone(outcome);
          }
          const canonical = sources.get(task.inputSchema);
          if (
            target.id !== source.targetId ||
            target.spec.version !== source.targetVersion ||
            (target.kind === "Task" ? "task" : "workflow") !==
              source.targetKind ||
            (canonical && targetKey(canonical) !== targetKey(target))
          ) {
            throw invalid("outcome target does not match source");
          }
          if (outcome._tag === "Succeeded") {
            return {
              _tag: "Succeeded" as const,
              value: decode(
                target.successSchema,
                structuredClone(outcome.value)
              ),
            };
          }
          if (outcome._tag === "DomainFailure") {
            return {
              _tag: "DomainFailure" as const,
              error: decode(target.errorSchema, structuredClone(outcome.error)),
            };
          }
          return structuredClone(outcome);
        });
      }
      const history: HistoryService = {
        events: (options = {}) =>
          read("events request", () => {
            const request = decode(EventRequest, options);
            const after = request.afterSequence ?? 0;
            return page(
              events.filter((event) => event.sequence > after),
              request,
              `${prefix}events/${after}/`,
              1_048_576
            );
          }),
        invocations: (options = {}) =>
          read("invocations request", () =>
            page(
              invocations,
              decode(PageRequest, options),
              `${prefix}invocations/`,
              2_097_152
            )
          ),
        outcome: outcomeRead,
      };
      return yield* Task.test(task.provide(Layer.succeed(History, history)), {
        input: fixtures.source,
        ...(fixtures.artifacts === undefined
          ? {}
          : { artifacts: fixtures.artifacts }),
        ...(fixtures.tags === undefined ? {} : { tags: fixtures.tags }),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active = false;
          })
        )
      );
    })
  );
}

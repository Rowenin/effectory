import { OperationError } from "@effectory/runtime/protocol";
import type { Run } from "@effectory/runtime/protocol";
import { TaskRuntimeError } from "@offtree/effectory-sdk";
import type { Application } from "@offtree/effectory-sdk";
import {
  checkJsonBudget,
  decode,
} from "@offtree/effectory-sdk/internal/boundary";
import {
  EventPage,
  EventRequest,
  InvocationPage,
  PageRequest,
  Source,
} from "@offtree/effectory-sdk/internal/report-history";
import type {
  HistoryService,
  InvocationItem,
  Outcome,
  Target,
} from "@offtree/effectory-sdk/internal/report-history";
import type { Schema } from "effect";
import { Effect } from "effect";

import type { HostStore } from "./host-store.ts";
import {
  normalizeInvocation,
  normalizeWorkflowInvocation,
  outputFields,
} from "./invocation-outcome.ts";
import type { NativeInvocation } from "./invocation-outcome.ts";

const invalid = (message: string) =>
  new TaskRuntimeError({ code: "InvalidBoundary", message });
const unavailable = () =>
  new TaskRuntimeError({
    code: "Unavailable",
    message: "Report source outcome is unavailable",
  });
const failure = (error: unknown): TaskRuntimeError => {
  if (error instanceof TaskRuntimeError) {
    return error;
  }
  if (error instanceof OperationError && error.code === "LimitExceeded") {
    return new TaskRuntimeError({
      code: "LimitExceeded",
      message: error.message,
    });
  }
  return unavailable();
};

/** Captures only host capabilities, never an application's Context or input-supplied identity. */
export function reportHistory(
  run: Run,
  registry: typeof Application.Registry.Service,
  store: typeof HostStore.Service,
  poll: (id: string) => Effect.Effect<NativeInvocation>,
  active: { readonly value: boolean },
  pollWorkflow: (run: Run, path: string) => Effect.Effect<NativeInvocation>
) {
  return Effect.gen(function* () {
    const context = yield* store
      .reportContext(run.runId)
      .pipe(Effect.mapError(failure));
    const source = yield* Effect.try({
      catch: failure,
      try: () => decode(Source, context.source),
    });
    const root = yield* store
      .getRun(source.runId, context.row.principal)
      .pipe(Effect.mapError(failure));
    const workflow =
      source.targetKind === "workflow" && source.invocationId !== null
        ? {
            invocationId: source.invocationId,
            ...(yield* store
              .reportWorkflowDetails(source.runId, source.invocationId)
              .pipe(Effect.mapError(failure))),
          }
        : null;
    const read = <A>(
      body: Effect.Effect<A, unknown>
    ): Effect.Effect<A, TaskRuntimeError> =>
      Effect.suspend(() => {
        if (!active.value) {
          return Effect.fail(invalid("Report invocation closed"));
        }
        return body.pipe(
          Effect.mapError(failure),
          Effect.flatMap((value) =>
            active.value
              ? Effect.succeed(value)
              : Effect.fail(invalid("Report invocation closed"))
          )
        );
      });
    const rawOutcome = (): Effect.Effect<
      Outcome<Schema.Json, Schema.Json>,
      TaskRuntimeError
    > =>
      Effect.gen(function* () {
        if (source.invocationId !== null) {
          const native = workflow
            ? yield* pollWorkflow(root, workflow.path)
            : yield* poll(source.invocationId);
          const facts = yield* store
            .invocationFacts(source.runId)
            .pipe(Effect.mapError(failure));
          const result = workflow
            ? normalizeWorkflowInvocation(native, facts, workflow.entered === 1)
            : normalizeInvocation(native, facts);
          if (result._tag !== "Complete" || result.status !== source.status) {
            return yield* unavailable();
          }
          return result.outcome;
        }
        if (source.status === "Succeeded") {
          return { _tag: "Succeeded", value: root.result };
        }
        if (source.status !== "Failed") {
          return { _tag: "Stopped", detail: root.error, status: source.status };
        }
        if (context.row.failureCategory === "Domain") {
          return { _tag: "DomainFailure", error: root.error };
        }
        if (
          context.row.failureCategory === "Host" ||
          context.row.failureCategory === "Defect"
        ) {
          return {
            _tag: "Failure",
            category: context.row.failureCategory,
            detail: root.error,
          };
        }
        return yield* unavailable();
      });
    const outcome = (target?: Target) =>
      read(
        Effect.gen(function* () {
          const value = yield* rawOutcome();
          return yield* Effect.try({
            catch: failure,
            try: () => {
              if (value._tag === "Succeeded") {
                checkJsonBudget(value.value);
              } else if (value._tag === "DomainFailure") {
                checkJsonBudget(value.error);
              } else {
                checkJsonBudget(value.detail);
              }
              if (target === undefined) {
                return value;
              }
              const canonical =
                source.targetKind === "task"
                  ? registry.tasks.get(source.targetId)?.spec === target.spec &&
                    target.kind === "Task"
                  : registry.workflows.get(source.targetId)?.definition ===
                    target;
              if (
                !canonical ||
                target.id !== source.targetId ||
                target.spec.version !== source.targetVersion
              ) {
                throw invalid(
                  "Report outcome target does not match the pinned source contract"
                );
              }
              if (value._tag === "Succeeded") {
                return {
                  ...value,
                  value: decode(target.successSchema, value.value),
                };
              }
              if (value._tag === "DomainFailure") {
                return {
                  ...value,
                  error: decode(target.errorSchema, value.error),
                };
              }
              return value;
            },
          });
        })
      );
    return {
      events: (options) =>
        read(
          Effect.gen(function* () {
            const request = yield* Effect.try({
              catch: () => invalid("Invalid report event request"),
              try: () => decode(EventRequest, options ?? {}),
            });
            const page = workflow
              ? yield* store.reportSubtreeEvents(
                  source.runId,
                  context.row.principal,
                  workflow.invocationId,
                  workflow.path,
                  request
                )
              : yield* store.eventPage(
                  { ...request, runId: source.runId },
                  context.row.principal
                );
            return yield* Effect.try({
              catch: failure,
              try: () => decode(EventPage, page),
            });
          })
        ),
      invocations: (options) =>
        read(
          Effect.gen(function* () {
            const request = yield* Effect.try({
              catch: () => invalid("Invalid report invocation request"),
              try: () => decode(PageRequest, options ?? {}),
            });
            const page = workflow
              ? yield* store.reportSubtreeInvocations(
                  source.runId,
                  context.row.principal,
                  workflow.invocationId,
                  workflow.path,
                  request
                )
              : yield* store.reportInvocationScan(
                  source.runId,
                  context.row.principal,
                  request
                );
            const facts = yield* store.invocationFacts(source.runId);
            const items: InvocationItem[] = [];
            let position = page.after;
            let more = false;
            for (const row of page.rows) {
              if (items.length >= page.limit) {
                more = true;
                break;
              }
              const task = registry.tasks.get(row.taskId);
              if (!task) {
                return yield* unavailable();
              }
              const state = normalizeInvocation(
                yield* poll(row.engineId),
                facts
              );
              const path = [...row.pathText];
              const item: InvocationItem = {
                attemptCount: row.attemptCount,
                invocationId: row.engineId,
                pathPreview: {
                  text: path.slice(0, 2048).join(""),
                  truncated: path.length > 2048,
                },
                providerId: task.providerId ?? null,
                status: outputFields(state).status,
                taskId: row.taskId,
                taskVersion: task.spec.version,
              };
              items.push(item);
              const preview = {
                cursor: page.cursor(row.position),
                items,
                snapshot: page.snapshot,
              };
              if (Buffer.byteLength(JSON.stringify(preview)) > 2_097_152) {
                items.pop();
                more = true;
                break;
              }
              ({ position } = row);
            }
            if (!more) {
              ({ more } = page);
              ({ position } = page);
            }
            if (more && items.length === 0 && page.rows.length > 0) {
              return yield* new TaskRuntimeError({
                code: "LimitExceeded",
                message: "Report invocation exceeds the history page budget",
              });
            }
            return yield* Effect.try({
              catch: failure,
              try: () =>
                decode(InvocationPage, {
                  cursor: more ? page.cursor(position) : null,
                  items,
                  snapshot: page.snapshot,
                }),
            });
          })
        ),
      // The generic overload's dependent return type follows the canonical target
      // check and its success/error decoding above; TypeScript cannot express it
      // on the optional-argument implementation.
      outcome: outcome as HistoryService["outcome"],
    } satisfies HistoryService;
  });
}

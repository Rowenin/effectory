/* oxlint-disable promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- Effect.catch is typed Effect recovery, not Promise chaining. */
import { OperationError } from "@effectory/runtime/protocol";
import { snapshot, validate } from "@offtree/effectory-sdk/internal/tag-state";
import { Clock, Effect, Layer } from "effect";

import { Catalog } from "./catalog.ts";
import { HostStore } from "./host-store.ts";
import { validatePolicies } from "./policies.ts";
import { resolveReportPlan } from "./report-plan.ts";

/** One observed revision per wake; the store fences admission inside its transaction. */
export const startScheduler = Effect.gen(function* () {
  const catalog = yield* Catalog;
  const store = yield* HostStore;
  let observed: string | undefined;
  let restart = true;
  const tick = Effect.gen(function* () {
    const application = yield* catalog.get();
    const now = yield* Clock.currentTimeMillis;
    if (application.revision !== observed) {
      const reports = yield* Effect.try({
        catch: () =>
          new OperationError({
            code: "InvalidInput",
            message:
              "Scheduled workflow execution policy is invalid or unsupported",
          }),
        try: () => {
          const resolved = new Map<
            string,
            ReturnType<typeof resolveReportPlan>
          >();
          for (const schedule of application.registry.schedules.values()) {
            validate(
              snapshot({ ...schedule.workflow.tags, ...schedule.tags }),
              schedule.workflow.tagSchemas
            );
            validatePolicies(application.registry, schedule.workflow.id);
            resolved.set(
              schedule.id,
              resolveReportPlan(
                application.registry,
                "workflow",
                schedule.workflow.id,
                schedule.reportSelection
              )
            );
          }
          return resolved;
        },
      });
      yield* store.scheduleReconcile(
        application.registry.schedules,
        application.revision,
        now,
        new Map([...reports].map(([id, report]) => [id, report.plan])),
        new Map([...reports].map(([id, report]) => [id, report.decision]))
      );
      observed = application.revision;
    }
    for (const id of yield* store.scheduleIds()) {
      yield* store
        .scheduleTick(id, now, restart)
        .pipe(
          Effect.catch((error) =>
            store.scheduleError(id, error, now).pipe(Effect.ignore)
          )
        );
    }
    restart = false;
  }).pipe(
    Effect.scoped,
    Effect.catch((error) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => store.scheduleError(null, error, now)),
        Effect.ignore
      )
    )
  );
  yield* tick;
  yield* Effect.sleep("1 second").pipe(
    Effect.andThen(tick),
    Effect.forever,
    Effect.forkScoped
  );
});
export const schedulerLayer = Layer.effectDiscard(startScheduler);

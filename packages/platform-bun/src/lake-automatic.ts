/* oxlint-disable no-loop-func -- Each yielded job closes over its own iteration. */
import type { Database } from "bun:sqlite";

import { AutomaticReclamationSet } from "@effectory/runtime/lake-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import { Clock, Effect, Schema } from "effect";

import { scanAutomaticRetention } from "./lake-automatic-scan.ts";
import {
  automaticState,
  automaticStatus,
  initializeAutomaticRetention,
} from "./lake-automatic-store.ts";
import { ReclamationJob, unlinkReclamationJob } from "./lake-reclamation.ts";
import type { Lease } from "./ownership.ts";
import { storageError } from "./storage-error.ts";

export function createAutomaticRetention(
  database: Database,
  directory: string,
  lease: Lease
) {
  initializeAutomaticRetention(database);
  let cleanupAfter = 0;
  const volatileFailures = new Map<
    "scanError" | "cleanupError",
    NonNullable<ReturnType<typeof automaticStatus>["lastError"]>
  >();
  const status = () =>
    automaticStatus(database, [...volatileFailures.values()]);
  const perform = <A>(body: () => A) =>
    Effect.try({
      catch: (error) =>
        storageError(error, "Automatic retention storage operation failed"),
      try: () => {
        lease.assertActive();
        return body();
      },
    });
  // Busy handling must wrap the synchronous transaction, never sleep inside it.
  const transaction = <A>(body: () => A) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      for (;;) {
        const result = yield* Effect.try({
          catch: (error) => ({
            busy:
              typeof error === "object" &&
              error !== null &&
              Reflect.get(error, "code") === "SQLITE_BUSY",
            error,
          }),
          try: () => {
            lease.assertActive();
            return database.transaction(body).immediate();
          },
        }).pipe(Effect.result);
        if (result._tag === "Success") {
          return result.success;
        }
        if (
          !result.failure.busy ||
          (yield* Clock.currentTimeMillis) - started >= 250
        ) {
          return yield* storageError(
            result.failure.error,
            "Automatic retention transaction failed"
          );
        }
        yield* Effect.sleep("10 millis");
      }
    });
  const recordError = (
    column: "scanError" | "cleanupError",
    error: OperationError
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const failure = {
        at: new Date(now).toISOString(),
        code: error.code,
        message:
          column === "scanError"
            ? "Automatic retention scan failed; inspect repository storage and automatic status"
            : "Committed reclamation cleanup could not be inspected; inspect repository storage and automatic status",
      };
      // Disk-full/busy storage may prevent persisting its own diagnostic. Keep it
      // visible in this host until the same operation succeeds.
      volatileFailures.set(column, failure);
      yield* perform(() =>
        database
          .query(`UPDATE lake_automatic_state SET ${column}=? WHERE id=1`)
          .run(canonical(failure))
      ).pipe(
        Effect.tap(() => Effect.sync(() => volatileFailures.delete(column))),
        Effect.catch(() => Effect.void)
      );
    });
  const automaticStep = (expectedGeneration?: number) =>
    Effect.gen(function* () {
      const state = yield* perform(() => automaticState(database));
      const now = yield* Clock.currentTimeMillis;
      if (!state.enabled || (state.checkpoint === null && now < state.nextAt)) {
        return false;
      }
      const generation = expectedGeneration ?? state.generation;
      const result = yield* transaction(() => {
        const busy = scanAutomaticRetention(database, generation, now);
        const current = automaticState(database);
        return {
          acknowledged:
            current.enabled === 1 && current.generation === generation,
          busy,
        };
      });
      if (result.acknowledged) {
        volatileFailures.delete("scanError");
      }
      return result.busy;
    });
  const cleanup = Effect.gen(function* () {
    const jobs = yield* perform(() =>
      Schema.decodeUnknownSync(Schema.Array(ReclamationJob))(
        database
          .query(
            "SELECT id,planId,digest,bytes,started FROM lake_reclamation_unlinks WHERE state='Pending' AND id>? ORDER BY id LIMIT 4"
          )
          .all(cleanupAfter)
      )
    );
    if (jobs.length === 0) {
      cleanupAfter = 0;
    }
    for (const job of jobs) {
      const now = yield* Clock.currentTimeMillis;
      yield* perform(() => {
        const pending = database
          .query(
            "SELECT id,planId,digest,bytes,started FROM lake_reclamation_unlinks WHERE id=? AND state='Pending'"
          )
          .get(job.id);
        if (!pending) {
          return;
        }
        try {
          unlinkReclamationJob(
            database,
            directory,
            Schema.decodeUnknownSync(ReclamationJob)(pending)
          );
        } catch {
          database
            .query(
              "UPDATE lake_reclamation_unlinks SET lastError=?,failedAt=? WHERE id=? AND state='Pending'"
            )
            .run("Committed blob cleanup failed", now, job.id);
        }
      });
      cleanupAfter = job.id;
      yield* Effect.yieldNow;
    }
    yield* perform(() =>
      database
        .query(
          "UPDATE lake_automatic_state SET cleanupError=NULL WHERE id=1 AND cleanupError IS NOT NULL"
        )
        .run()
    );
    volatileFailures.delete("cleanupError");
    return jobs.length > 0;
  });
  return {
    automaticMaintenance: Effect.gen(function* () {
      const scanning = yield* automaticStep().pipe(
        Effect.catch((error) =>
          recordError("scanError", error).pipe(Effect.as(false))
        )
      );
      const cleaning = yield* cleanup.pipe(
        Effect.catch((error) =>
          recordError("cleanupError", error).pipe(Effect.as(false))
        )
      );
      return scanning || cleaning;
    }),
    automaticSet: (value: typeof AutomaticReclamationSet.Type) =>
      Effect.gen(function* () {
        const request = yield* Effect.try({
          catch: () =>
            new OperationError({
              code: "InvalidInput",
              message: "Invalid automatic retention setting",
            }),
          try: () =>
            Schema.decodeUnknownSync(AutomaticReclamationSet)(value, {
              onExcessProperty: "error",
            }),
        });
        const now = yield* Clock.currentTimeMillis;
        return yield* transaction(() => {
          const state = automaticState(database);
          if (Boolean(state.enabled) !== request.enabled) {
            database
              .query(
                "UPDATE lake_automatic_state SET enabled=?,generation=generation+1,changedAt=?,checkpoint=NULL,nextAt=0 WHERE id=1"
              )
              .run(request.enabled ? 1 : 0, new Date(now).toISOString());
          }
          return status();
        });
      }),
    automaticStatus: perform(status),
    automaticStep,
  };
}

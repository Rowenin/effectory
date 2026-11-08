import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { BunCrypto } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Layer, Schema } from "effect";
import {
  EntityAddress,
  EntityId,
  EntityType,
  MessageStorage,
  ShardId,
  ShardingConfig,
  SqlMessageStorage,
} from "effect/cluster";

import { createStore } from "./host-store.ts";
import { ownershipLayer, RepositoryLease } from "./ownership.ts";
import {
  createRetirementStore,
  retirementDeletionSteps,
  retirementSql,
} from "./run-retirement-store.ts";
import type { RetirementSelector } from "./run-retirement-store.ts";
import {
  retiredRun,
  retirementError,
  RetirementReceipt,
} from "./run-retirement.ts";
import { readStoredCredentials } from "./runtime-storage-format.ts";
import { assertRuntimeWriter } from "./runtime-writer-guard.ts";
import { storageError } from "./storage-error.ts";

export const retirementMarker = "run-retirement.pending";
const markerFor = (filename: string) =>
  path.join(path.dirname(filename), retirementMarker);
const flush = (filename: string) => {
  const fd = openSync(filename, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
const mark = (filename: string) => {
  const marker = markerFor(filename);
  if (!existsSync(marker)) {
    writeFileSync(marker, "1\n", { flag: "wx", mode: 0o600 });
    flush(marker);
    flush(path.dirname(marker));
  }
  if (
    !lstatSync(marker).isFile() ||
    lstatSync(marker).isSymbolicLink() ||
    readFileSync(marker, "utf-8") !== "1\n"
  ) {
    throw retirementError("Unavailable", "Invalid retirement recovery marker");
  }
};
const unmark = (filename: string) => {
  const marker = markerFor(filename);
  if (existsSync(marker)) {
    unlinkSync(marker);
    flush(path.dirname(marker));
  }
};
export type ReclamationAction =
  | { readonly kind: "plan"; readonly selector: RetirementSelector }
  | { readonly kind: "apply"; readonly planId: string }
  | { readonly kind: "inspect"; readonly runId: string }
  | { readonly kind: "compact" };
export type ReclamationStep = (stage: string) => Effect.Effect<void>;
const noStep: ReclamationStep = () => Effect.void;

function cleanup(
  db: Database,
  filename: string,
  repositoryId: string,
  principal: string,
  planId: string,
  step: ReclamationStep
) {
  const store = createRetirementStore(db, repositoryId, principal);
  return Effect.gen(function* () {
    for (const [table, where] of retirementDeletionSteps(planId)) {
      if (!table || !where) {
        continue;
      }
      while (
        (yield* retirementSql(() => store.deleteBatch(planId, table, where))) >
        0
      ) {
        yield* step(`delete/${table}`);
        yield* Effect.yieldNow;
      }
    }
    yield* step("host-deleted");
    const native = Effect.gen(function* () {
      const storage = yield* MessageStorage.MessageStorage;
      for (;;) {
        const page = yield* retirementSql(() =>
          db
            .query<{ entityType: string; entityId: string }, [string]>(
              "SELECT entityType,entityId FROM host_retirement_native WHERE planId=? ORDER BY entityType,entityId LIMIT 256"
            )
            .all(planId)
        );
        if (!page.length) {
          break;
        }
        for (const address of page) {
          yield* step("before-native-clear");
          // SqlMessageStorage.clearAddress keys deletion by entity type/id, not routing shard.
          yield* storage
            .clearAddress(
              EntityAddress.make({
                entityId: EntityId.make(address.entityId),
                entityType: EntityType.make(address.entityType),
                shardId: ShardId.make("default", 1),
              })
            )
            .pipe(
              Effect.mapError((cause) =>
                storageError(
                  cause,
                  `Native cleanup interrupted; retry run reclaim apply ${planId}`
                )
              )
            );
          yield* step("after-native-clear");
          yield* retirementSql(() =>
            db
              .query(
                "DELETE FROM host_retirement_native WHERE planId=? AND entityType=? AND entityId=?"
              )
              .run(planId, address.entityType, address.entityId)
          );
        }
        yield* Effect.yieldNow;
      }
    });
    const hasNative = yield* retirementSql(() =>
      db
        .query("SELECT 1 FROM host_retirement_native WHERE planId=? LIMIT 1")
        .get(planId)
    );
    if (hasNative) {
      yield* native.pipe(
        Effect.provide(
          SqlMessageStorage.layer.pipe(
            Layer.provide(SqliteClient.layer({ filename })),
            Layer.provide(ShardingConfig.layerDefaults),
            Layer.provide(BunCrypto.layer)
          )
        )
      );
    }
    yield* step("before-receipt");
    const receipt = yield* retirementSql(() => store.complete(planId));
    yield* step("after-receipt");
    return receipt;
  });
}
function recover(db: Database, filename: string, step: ReclamationStep) {
  return Effect.gen(function* () {
    for (;;) {
      const row = yield* retirementSql(() =>
        db
          .query<
            { planId: string; repositoryId: string; principal: string },
            []
          >(
            "SELECT planId,repositoryId,principal FROM host_retirement_plans WHERE state='Applying' ORDER BY planId LIMIT 1"
          )
          .get()
      );
      if (!row) {
        break;
      }
      yield* cleanup(
        db,
        filename,
        row.repositoryId,
        row.principal,
        row.planId,
        step
      ).pipe(
        Effect.mapError((cause) =>
          retirementError(
            storageError(cause, "Retirement recovery failed").code,
            `${cause.message}; retirement recovery requires run reclaim apply ${row.planId}`
          )
        )
      );
    }
    yield* retirementSql(() => unmark(filename));
  });
}
const databaseResource = (filename: string) =>
  Effect.acquireRelease(
    retirementSql(() => new Database(filename, { strict: true })),
    (db) => Effect.sync(() => db.close())
  );
/** Called before ANY host Layer is built; requires exclusive ownership, never starts an engine. */
export function recoverRunReclamation(
  filename: string,
  step: ReclamationStep = noStep
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* RepositoryLease;
      yield* retirementSql(() => {
        lease.assertActive();
        assertRuntimeWriter(path.dirname(path.dirname(filename)));
      });
      if (!existsSync(markerFor(filename))) {
        return;
      }
      yield* retirementSql(() => {
        lease.assertActive();
        mark(filename);
        if (!existsSync(filename)) {
          throw retirementError(
            "Unavailable",
            "Retirement marker exists without its database"
          );
        }
      });
      const db = yield* databaseResource(filename);
      yield* retirementSql(() => createStore(db, lease));
      yield* recover(db, filename, step);
    })
  );
}
export function reclaimRuns(
  repository: string,
  action: ReclamationAction,
  step: ReclamationStep = noStep
) {
  const filename = path.join(
    path.resolve(repository),
    ".effectory",
    "state.sqlite"
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* RepositoryLease;
      const repositoryId = yield* retirementSql(() => {
        lease.assertActive();
        assertRuntimeWriter(repository);
        if (!existsSync(filename)) {
          throw retirementError(
            "NotFound",
            "Repository run history was not found"
          );
        }
        return readStoredCredentials(repository).repositoryId;
      });
      const db = yield* databaseResource(filename);
      yield* retirementSql(() => createStore(db, lease));
      if (existsSync(markerFor(filename))) {
        yield* retirementSql(() => mark(filename));
      }
      yield* recover(db, filename, step);
      const store = createRetirementStore(db, repositoryId, "owner");
      switch (action.kind) {
        case "inspect": {
          const record = yield* retirementSql(() =>
            retiredRun(db, action.runId, "owner")
          );
          if (!record) {
            return yield* retirementError(
              "NotFound",
              "Run has not been retired"
            );
          }
          return record;
        }
        case "plan": {
          return yield* store.plan(action.selector);
        }
        case "compact": {
          yield* step("before-compact");
          const result = yield* retirementSql(() => {
            const checkpoint = () => {
              const checkpointResult = db
                .query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
                .get();
              if (checkpointResult?.busy !== 0) {
                throw retirementError(
                  "Unavailable",
                  "Checkpoint is busy; retry run reclaim compact after other database readers close"
                );
              }
            };
            checkpoint();
            const beforeBytes = statSync(filename).size;
            db.exec("VACUUM");
            checkpoint();
            flush(filename);
            flush(path.dirname(filename));
            return { afterBytes: statSync(filename).size, beforeBytes };
          });
          yield* step("after-compact");
          return result;
        }
        case "apply": {
          const row = yield* store.validate(action.planId);
          if (row.state === "Complete") {
            return yield* retirementSql(() =>
              Schema.decodeUnknownSync(RetirementReceipt)(
                JSON.parse(row.receiptJson ?? "null")
              )
            );
          }
          yield* retirementSql(() => mark(filename));
          yield* step("marker");
          yield* retirementSql(() => store.begin(action.planId));
          yield* step("intent");
          const receipt = yield* cleanup(
            db,
            filename,
            repositoryId,
            "owner",
            action.planId,
            step
          ).pipe(
            Effect.mapError((cause) =>
              retirementError(
                storageError(cause, "Retirement apply failed").code,
                `${cause.message}; retry run reclaim apply ${action.planId}`
              )
            )
          );
          yield* retirementSql(() => unmark(filename));
          return receipt;
        }
        default: {
          return yield* retirementError(
            "InvalidInput",
            "Unknown reclamation operation"
          );
        }
      }
    })
  ).pipe(
    Effect.provide(ownershipLayer(`${filename}.owner`)),
    Effect.catchTag("RepositoryBusy", (cause) =>
      Effect.fail(
        retirementError(
          "Conflict",
          `${cause.message}; stop the daemon before run reclaim maintenance`
        )
      )
    )
  );
}

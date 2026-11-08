import { BunCrypto } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { OperationError } from "@effectory/runtime/protocol";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import {
  EntityAddress,
  EntityId,
  EntityType,
  MessageStorage,
  ShardId,
  ShardingConfig,
  SqlMessageStorage,
} from "effect/cluster";
import { Rpc } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { Workflow } from "effect/workflow";

import { ExecutionFailure } from "./execution-boundary.ts";
import type { NativeInvocation } from "./invocation-outcome.ts";

const resultCodec = Schema.toCodecJson(
  Rpc.exitSchema(
    Rpc.make("run", {
      success: Workflow.Result({
        error: ExecutionFailure,
        success: Schema.Json,
      }),
    })
  )
);
const unsupported = () =>
  new OperationError({
    code: "RevisionUnavailable",
    message:
      "Stored native task history is unsupported or damaged; preserve it for its compatible host",
  });

/**
 * The pinned Effect SQL message format. Uses only lookup APIs, never registers
 * an entity, sends a message, constructs a runner or imports retained code.
 */
export function nativeTaskResult(engineId: string) {
  const read = Effect.gen(function* (): Effect.fn.Return<
    NativeInvocation,
    OperationError,
    MessageStorage.MessageStorage | SqlClient.SqlClient
  > {
    const storage = yield* MessageStorage.MessageStorage;
    const sql = yield* SqlClient.SqlClient;
    // The primary key includes entity type/id, method and request id. The shard
    // is a placeholder for this lookup only; it is never used for routing.
    const address = EntityAddress.make({
      entityId: EntityId.make(engineId),
      entityType: EntityType.make("Workflow/EffectoryTask/v1"),
      shardId: ShardId.make("default", 1),
    });
    const request = yield* storage
      .requestIdForPrimaryKey({ address, id: "", tag: "run" })
      .pipe(
        Effect.mapError(
          () =>
            new OperationError({
              code: "Unavailable",
              message: "Native task history storage is unavailable",
            })
        )
      );
    if (Option.isNone(request)) {
      return Option.none();
    }
    // Check lengths before MessageStorage materializes/JSON-decodes payloads.
    // Normal run RPCs have one WithExit; bound unexpected stored replies too.
    const sizes = yield* sql<{ bytes: number | null; supported: number }>`
      SELECT
        CASE WHEN typeof(payload)='text' THEN octet_length(payload) ELSE NULL END AS bytes,
        CASE WHEN typeof(id)='integer' AND typeof(request_id)='integer' AND (
          (typeof(kind)='integer' AND kind=0 AND sequence IS NULL) OR
          (kind IS NULL AND typeof(sequence)='integer' AND sequence BETWEEN 0 AND 9007199254740991)
        ) THEN 1 ELSE 0 END AS supported
      FROM cluster_replies
      WHERE request_id = ${String(request.value)} ORDER BY rowid LIMIT 257
    `.pipe(Effect.mapError(unsupported));
    let bytes = 0;
    for (const row of sizes) {
      if (
        row.supported !== 1 ||
        row.bytes === null ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 0
      ) {
        return yield* unsupported();
      }
      bytes += row.bytes;
    }
    if (sizes.length > 256 || bytes > 16_777_216) {
      return yield* unsupported();
    }
    const replies = yield* storage
      .repliesForUnfiltered([request.value])
      .pipe(Effect.mapError(unsupported));
    const last = replies.at(-1);
    if (last === undefined || last._tag !== "WithExit") {
      return Option.none();
    }
    const decoded = yield* Effect.suspend(() =>
      Schema.decodeUnknownEffect(resultCodec)(last.exit)
    ).pipe(Effect.mapError(unsupported));
    if (Exit.isFailure(decoded)) {
      // This is the outer RPC exit, not the task's stored domain/host outcome.
      return yield* unsupported();
    }
    return Option.some(decoded.value);
  });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Live readers must use the same snapshot for the size check and decoding.
    // Both live engine storage and nativeHistoryLayer capture this SqlClient.
    return yield* read.pipe(
      sql.withTransaction,
      Effect.mapError((error) =>
        error instanceof OperationError ? error : unsupported()
      ),
      Effect.catchCauseIf(Cause.hasDies, () => Effect.fail(unsupported()))
    );
  });
}

/**
 * For an already verified, private, checkpointed inspection copy only. Source
 * repositories must be captured under ownership by withUpgradeInspection (or
 * withRuntimeInspection for same-build inspection) before using this Layer.
 * layerStorage deliberately omits the Effect migrations and runner Layers.
 */
export function nativeHistoryLayer(filename: string) {
  return SqlMessageStorage.layerStorage({}).pipe(
    Layer.provide(ShardingConfig.layerDefaults),
    Layer.provide(BunCrypto.layer),
    Layer.provideMerge(SqliteClient.layer({ filename, readonly: true }))
  );
}

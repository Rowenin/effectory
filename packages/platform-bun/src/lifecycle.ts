import type { Database } from "bun:sqlite";

import { OperationError } from "@effectory/runtime/protocol";
import { DrainRequest, DrainReceipt } from "@effectory/runtime/system-protocol";
import { Schema } from "effect";

const Row = Schema.Struct({
  deadline: Schema.NullOr(Schema.Finite),
  gracePeriodMs: Schema.NullOr(Schema.Int),
  instanceId: Schema.String,
  requestKey: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
});

const receipt = (row: typeof Row.Type) =>
  row.requestKey === null || row.deadline === null
    ? null
    : DrainReceipt.make({
        deadline: row.deadline,
        instanceId: row.instanceId,
        requestKey: row.requestKey,
        status: "Draining",
      });

export function createLifecycle(database: Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS host_daemons (
    instanceId TEXT PRIMARY KEY, startedAt TEXT NOT NULL, requestKey TEXT, gracePeriodMs INTEGER, deadline REAL
  )`);
  let current: string | null = null;
  let accepting = true;
  const read = (instanceId: string) => {
    const raw = database
      .query("SELECT * FROM host_daemons WHERE instanceId = ?")
      .get(instanceId);
    return raw === null ? null : Schema.decodeUnknownSync(Row)(raw);
  };
  return {
    get accepting() {
      return accepting;
    },
    begin: (instanceId: string) => {
      database.transaction(() => {
        const { count } = Schema.decodeUnknownSync(
          Schema.Struct({ count: Schema.Int })
        )(database.query("SELECT COUNT(*) AS count FROM host_daemons").get());
        if (count >= 10_000) {
          throw new OperationError({
            code: "LimitExceeded",
            message: "Daemon instance history reached 10000 entries",
          });
        }
        database
          .query(
            "INSERT INTO host_daemons(instanceId, startedAt) VALUES (?, ?)"
          )
          .run(instanceId, new Date().toISOString());
      })();
      current = instanceId;
      accepting = true;
    },
    drain: (value: typeof DrainRequest.Type) => {
      const request = Schema.decodeUnknownSync(DrainRequest)(value, {
        onExcessProperty: "error",
      });
      const result = database.transaction(() => {
        const row = read(request.instanceId);
        const previous = row === null ? null : receipt(row);
        if (previous !== null) {
          if (
            previous.requestKey !== request.requestKey ||
            row?.gracePeriodMs !== request.gracePeriodMs
          ) {
            throw new OperationError({
              code: "Conflict",
              message: "Daemon drain request differs from the accepted request",
            });
          }
          return previous;
        }
        if (request.instanceId !== current || row === null) {
          throw new OperationError({
            code: "Conflict",
            message: "Daemon instance changed",
          });
        }
        const deadline = Date.now() + Math.max(200, request.gracePeriodMs);
        database
          .query(
            "UPDATE host_daemons SET requestKey = ?, gracePeriodMs = ?, deadline = ? WHERE instanceId = ?"
          )
          .run(
            request.requestKey,
            request.gracePeriodMs,
            deadline,
            request.instanceId
          );
        return DrainReceipt.make({
          deadline,
          instanceId: request.instanceId,
          requestKey: request.requestKey,
          status: "Draining",
        });
      })();
      if (result.instanceId === current) {
        accepting = false;
      }
      return result;
    },
    status: () => {
      const row = current === null ? null : read(current);
      if (row === null) {
        throw new OperationError({
          code: "Unavailable",
          message: "Daemon instance has not registered",
        });
      }
      return {
        drain: receipt(row),
        instanceId: row.instanceId,
        startedAt: row.startedAt,
      };
    },
  };
}

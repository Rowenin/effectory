import type { Database } from "bun:sqlite";

import {
  OperationError,
  Outbox,
  WaitStatus,
} from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import type { InspectionBudget } from "./inspection-budget.ts";
import { storageError } from "./storage-error.ts";
import { upgradePage } from "./upgrade-page.ts";

const maximumRows = 1_000_000;
const maximumBytes = 268_435_456;
const Row = Schema.Struct({
  id: Schema.Int,
  kind: Schema.String,
  owner: Schema.NullOr(Schema.String),
  runId: Schema.String,
  waitId: Schema.NullOr(Schema.String),
  waitOwner: Schema.NullOr(Schema.String),
  waitStatus: Schema.NullOr(Schema.String),
});
const unavailable = (id: number) =>
  new OperationError({
    code: "RevisionUnavailable",
    message: `Pending execution intent ${id} is unsupported or orphaned. Preserve the repository and use its compatible host; no intent was acknowledged.`,
  });

/** Inspect the entire pending index, not the runner's first joined page. */
export function inspectUpgradeOutbox(
  database: Database,
  budget?: InspectionBudget
) {
  return Effect.gen(function* () {
    const table = yield* Effect.try({
      catch: (cause) =>
        storageError(cause, "Cannot inspect pending execution work"),
      try: () =>
        database
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='host_outbox'"
          )
          .get(),
    });
    if (table === null) {
      return {
        bytes: 0,
        counts: { Cancel: 0, Dispatch: 0, Settle: 0 },
        rows: 0,
      };
    }
    // Validate the flag domain through the pending index, rather than silently
    // ignoring NULL/future flag values or scanning all delivered history.
    yield* Effect.try({
      catch: (cause) =>
        cause instanceof OperationError ? cause : unavailable(0),
      try: () => {
        const indexes = database
          .query<{ name: string; partial: number }, []>(
            "PRAGMA index_list(host_outbox)"
          )
          .all();
        const columns = database
          .query<{ name: string }, []>("PRAGMA index_info(host_outbox_pending)")
          .all();
        if (
          !indexes.some(
            (index) =>
              index.name === "host_outbox_pending" && index.partial === 0
          ) ||
          JSON.stringify(columns.map((column) => column.name)) !==
            JSON.stringify(["delivered", "id"])
        ) {
          throw new OperationError({
            code: "RevisionUnavailable",
            message:
              "Execution work is missing its supported pending index; preserve it for a compatible host",
          });
        }
        const first = database
          .query<{ delivered: unknown }, []>(
            "SELECT delivered FROM host_outbox INDEXED BY host_outbox_pending ORDER BY delivered LIMIT 1"
          )
          .get();
        const afterZero = database
          .query<{ delivered: unknown }, []>(
            "SELECT delivered FROM host_outbox INDEXED BY host_outbox_pending WHERE delivered > 0 ORDER BY delivered LIMIT 1"
          )
          .get();
        const afterOne = database
          .query(
            "SELECT 1 FROM host_outbox INDEXED BY host_outbox_pending WHERE delivered > 1 LIMIT 1"
          )
          .get();
        for (const flag of [first, afterZero, afterOne]) {
          if (flag !== null) {
            budget?.visit("outbox delivery domain", flag);
          }
        }
        if (
          (first !== null && first.delivered !== 0 && first.delivered !== 1) ||
          (afterZero !== null && afterZero.delivered !== 1) ||
          afterOne !== null
        ) {
          throw new OperationError({
            code: "RevisionUnavailable",
            message:
              "Execution work has an unsupported delivery state; preserve it for a compatible host",
          });
        }
      },
    });
    let cursor: number | null = null;
    let rows = 0;
    let bytes = 0;
    const counts = { Cancel: 0, Dispatch: 0, Settle: 0 };
    const page = () =>
      Effect.try({
        catch: (cause) =>
          cause instanceof OperationError
            ? cause
            : new OperationError({
                code: "RevisionUnavailable",
                message:
                  "Pending execution work uses an unsupported storage shape; preserve it for a compatible host",
              }),
        try: () =>
          database.transaction(() => {
            const selected = upgradePage(
              database,
              `
          SELECT o.id,o.kind,o.runId,o.waitId,r.runId AS owner,w.runId AS waitOwner,w.status AS waitStatus
          FROM host_outbox o LEFT JOIN host_runs r ON r.runId=o.runId
          LEFT JOIN host_waits w ON w.waitId=o.waitId
          WHERE o.delivered=0 ${cursor === null ? "" : "AND o.id>?"} ORDER BY o.id LIMIT ?
        `,
              cursor === null ? [] : [cursor]
            );
            const result = Schema.decodeUnknownSync(Schema.Array(Row))(
              selected.rows,
              { onExcessProperty: "error" }
            );
            for (const row of result) {
              const decoded = Schema.decodeUnknownOption(Outbox)({
                id: row.id,
                kind: row.kind,
                runId: row.runId,
                waitId: row.waitId,
              });
              if (
                decoded._tag === "None" ||
                row.owner === null ||
                !Number.isSafeInteger(row.id) ||
                row.id < 1 ||
                (cursor !== null && row.id <= cursor)
              ) {
                throw unavailable(row.id);
              }
              const intent = decoded.value;
              if (
                intent.kind === "Settle"
                  ? row.waitId === null ||
                    row.waitOwner !== row.runId ||
                    !Schema.is(WaitStatus)(row.waitStatus) ||
                    row.waitStatus === "Open"
                  : row.waitId !== null
              ) {
                throw unavailable(row.id);
              }
              budget?.visit("pending execution intent", row);
              rows += 1;
              bytes += Buffer.byteLength(JSON.stringify(row));
              if (rows > maximumRows || bytes > maximumBytes) {
                throw new OperationError({
                  code: "LimitExceeded",
                  message:
                    "Pending-work inspection exceeds one million intents or 256 MiB; drain work with the compatible host before upgrading",
                });
              }
              counts[intent.kind] += 1;
              cursor = row.id;
            }
            return selected.more;
          })(),
      });
    for (;;) {
      const more = yield* page();
      if (!more) {
        return { bytes, counts, rows };
      }
      yield* Effect.yieldNow;
    }
  });
}

import type { Database } from "bun:sqlite";

import { CheckListRequest } from "@effectory/runtime/check-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import {
  CheckRecord,
  checkLimits,
  checkReservation,
} from "@offtree/effectory-sdk/internal/check-schema";
import type {
  CheckStart,
  CheckFinish,
} from "@offtree/effectory-sdk/internal/check-state";
import { Schema } from "effect";

import type { Lease } from "./ownership.ts";
import type { createPagination } from "./pagination.ts";
import { refuseRetired } from "./run-retirement.ts";

export interface CheckIdentity {
  readonly runId: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly entry: number;
}
const fail = (code: OperationError["code"], message: string): never => {
  throw new OperationError({ code, message });
};
const number = (row: unknown, key: string) =>
  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Int))(row)[
    key
  ] ?? 0;

export function createCheckStore(
  db: Database,
  lease: Lease,
  pagination: ReturnType<typeof createPagination>,
  live: (
    runId: string,
    nodeId: string,
    attempt: number,
    entry: number
  ) => boolean,
  event: (runId: string, key: string, tag: string, payload: Schema.Json) => void
) {
  db.run(`CREATE TABLE IF NOT EXISTS host_checks (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, invocationPosition INTEGER NOT NULL, runId TEXT NOT NULL, nodeId TEXT NOT NULL, taskId TEXT NOT NULL,
    attempt INTEGER NOT NULL, entry INTEGER NOT NULL, id TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL,
    status TEXT NOT NULL, startedAt TEXT NOT NULL, finishedAt TEXT, durationMillis REAL, owner TEXT NOT NULL,
    UNIQUE(runId,nodeId,attempt,entry,id));
    CREATE INDEX IF NOT EXISTS host_checks_run_sequence ON host_checks(runId,sequence);
    CREATE INDEX IF NOT EXISTS host_checks_invocation_order ON host_checks(runId,invocationPosition,sequence);
    CREATE INDEX IF NOT EXISTS host_checks_running ON host_checks(sequence) WHERE status='Running';
    CREATE TABLE IF NOT EXISTS host_check_budget(runId TEXT PRIMARY KEY, rows INTEGER NOT NULL, bytes INTEGER NOT NULL);`);
  let after = 0;
  const identityCurrent = (identity: CheckIdentity) =>
    live(identity.runId, identity.nodeId, identity.attempt, identity.entry) &&
    db
      .query(
        `SELECT 1 FROM host_attempts WHERE runId=? AND nodeId=? AND activityAttempt=? AND entries=? AND owner=?`
      )
      .get(
        identity.runId,
        identity.nodeId,
        identity.attempt,
        identity.entry,
        lease.token
      ) !== null;
  const finishedEvent = (record: CheckRecord, status: string) =>
    event(
      record.runId,
      `check/${record.sequence}/finished`,
      "AssertionFinished",
      { checkSequence: record.sequence, status }
    );
  const reconcileRow = (raw: unknown): CheckRecord => {
    const row = Schema.decodeUnknownSync(CheckRecord)(raw);
    const { owner } = Schema.decodeUnknownSync(
      Schema.Struct({ owner: Schema.String })
    )(raw);
    if (
      row.status !== "Running" ||
      (owner === lease.token && identityCurrent(row))
    ) {
      return row;
    }
    const finishedAt = new Date().toISOString();
    db.query(
      "UPDATE host_checks SET status='Incomplete',finishedAt=?,durationMillis=NULL,message='Assertion evaluation did not finish' WHERE sequence=? AND status='Running'"
    ).run(finishedAt, row.sequence);
    finishedEvent(row, "Incomplete");
    return {
      ...row,
      durationMillis: null,
      finishedAt,
      message: "Assertion evaluation did not finish",
      status: "Incomplete",
    };
  };
  const reconcile = () =>
    db
      .transaction(() => {
        lease.assertActive();
        const rows = db
          .query(
            "SELECT * FROM host_checks WHERE status='Running' AND sequence>? ORDER BY sequence LIMIT 256"
          )
          .all(after);
        for (const raw of rows) {
          after = reconcileRow(raw).sequence;
        }
        if (rows.length < 256) {
          after = 0;
        }
      })
      .immediate();
  return {
    finish: (identity: CheckIdentity, sequence: number, result: CheckFinish) =>
      db
        .transaction(() => {
          lease.assertActive();
          if (
            !identityCurrent(identity) ||
            db
              .query(
                "SELECT 1 FROM host_runs WHERE runId=? AND status IN ('Queued','Running','Waiting','Retrying','NeedsAttention')"
              )
              .get(identity.runId) === null ||
            db
              .query("SELECT 1 FROM host_fences WHERE runId=?")
              .get(identity.runId) !== null
          ) {
            fail("Conflict", "Check entry is closed or superseded");
          }
          const raw = db
            .query(
              "SELECT * FROM host_checks WHERE sequence=? AND runId=? AND nodeId=? AND attempt=? AND entry=? AND status='Running'"
            )
            .get(
              sequence,
              identity.runId,
              identity.nodeId,
              identity.attempt,
              identity.entry
            );
          if (raw === null) {
            fail("Conflict", "Check observation is no longer running");
          }
          const record = Schema.decodeUnknownSync(CheckRecord)(raw);
          db.query(
            "UPDATE host_checks SET status=?,message=?,finishedAt=?,durationMillis=? WHERE sequence=?"
          ).run(
            result.status,
            result.message,
            new Date().toISOString(),
            result.durationMillis,
            sequence
          );
          finishedEvent(record, result.status);
        })
        .immediate(),
    list: (value: typeof CheckListRequest.Type, principal: string) =>
      db
        .transaction(() => {
          lease.assertActive();
          const request = Schema.decodeSync(CheckListRequest)(value, {
            onExcessProperty: "error",
          });
          if (
            db
              .query("SELECT 1 FROM host_runs WHERE runId=? AND principal=?")
              .get(request.runId, principal) === null
          ) {
            refuseRetired(db, "run", request.runId, principal);
            fail("NotFound", "Run was not found");
          }
          const attempts = request.attempts ?? "latest";
          const scope = {
            kind: "checks",
            principal,
            query: { attempts, runId: request.runId },
          };
          const token = pagination.read(scope, request.cursor);
          const snapshot = token
            ? Schema.decodeUnknownSync(Schema.Int)(token.snapshot)
            : number(
                db
                  .query(
                    "SELECT COALESCE(MAX(sequence),0) value FROM host_checks WHERE runId=?"
                  )
                  .get(request.runId),
                "value"
              );
          let position: readonly [number, number] = token
            ? Schema.decodeUnknownSync(Schema.Tuple([Schema.Int, Schema.Int]))(
                token.position
              )
            : [0, 0];
          const rawRows = db
            .query(
              `SELECT c.*,(NOT EXISTS(SELECT 1 FROM host_attempts a WHERE a.runId=c.runId AND a.nodeId=c.nodeId AND (a.activityAttempt>c.attempt OR (a.activityAttempt=c.attempt AND a.entries>c.entry)))) latest FROM host_checks c WHERE runId=? AND (invocationPosition,sequence)>(?,?) ORDER BY invocationPosition,sequence LIMIT 256`
            )
            .all(request.runId, position[0], position[1]);
          const items: CheckRecord[] = [];
          let bytes = 0;
          let consumed = 0;
          for (const raw of rawRows.slice(0, 255)) {
            if (items.length >= (request.limit ?? 50)) {
              break;
            }
            const row = reconcileRow(raw);
            const { invocationPosition, latest } = Schema.decodeUnknownSync(
              Schema.Struct({
                invocationPosition: Schema.Int,
                latest: Schema.Int,
              })
            )(raw);
            const selected =
              row.sequence <= snapshot && (attempts === "all" || latest === 1);
            if (selected) {
              const size = Buffer.byteLength(JSON.stringify(row));
              if (bytes + size > 2_097_152) {
                break;
              }
              bytes += size;
              items.push(row);
            }
            consumed += 1;
            position = [invocationPosition, row.sequence];
          }
          return {
            cursor:
              consumed < rawRows.length
                ? pagination.write(
                    scope,
                    snapshot,
                    position,
                    token?.expires ?? Date.now() + 900_000
                  )
                : null,
            items,
            snapshot,
          };
        })
        .immediate(),
    reconcile,
    start: (identity: CheckIdentity, input: CheckStart) =>
      db
        .transaction(() => {
          lease.assertActive();
          if (
            !identityCurrent(identity) ||
            db
              .query(
                "SELECT 1 FROM host_runs WHERE runId=? AND status IN ('Queued','Running','Waiting','Retrying','NeedsAttention')"
              )
              .get(identity.runId) === null ||
            db
              .query("SELECT 1 FROM host_fences WHERE runId=?")
              .get(identity.runId) !== null
          ) {
            fail("Conflict", "Check entry is closed or superseded");
          }
          if (
            db
              .query(
                "SELECT 1 FROM host_checks WHERE runId=? AND nodeId=? AND attempt=? AND entry=? AND id=?"
              )
              .get(
                identity.runId,
                identity.nodeId,
                identity.attempt,
                identity.entry,
                input.id
              ) !== null
          ) {
            fail("InvalidInput", "Duplicate check id in this entry");
          }
          const invocationPosition = number(
            db
              .query(
                "SELECT rowid position FROM host_invocations WHERE runId=? AND nodeId=?"
              )
              .get(identity.runId, identity.nodeId),
            "position"
          );
          const record: CheckRecord = {
            ...identity,
            ...input,
            durationMillis: null,
            finishedAt: null,
            sequence: 0,
            startedAt: new Date().toISOString(),
            status: "Running",
          };
          const reserved = checkReservation(record);
          const entries = number(
            db
              .query(
                "SELECT COUNT(*) count FROM host_checks WHERE runId=? AND nodeId=? AND attempt=? AND entry=?"
              )
              .get(
                identity.runId,
                identity.nodeId,
                identity.attempt,
                identity.entry
              ),
            "count"
          );
          const budget = db
            .query<{ rows: number; bytes: number }, [string]>(
              "SELECT rows,bytes FROM host_check_budget WHERE runId=?"
            )
            .get(identity.runId);
          if (
            entries >= checkLimits.entry ||
            (budget?.rows ?? 0) >= checkLimits.rows ||
            reserved > checkLimits.recordBytes ||
            (budget?.bytes ?? 0) + reserved > checkLimits.runBytes
          ) {
            fail("LimitExceeded", "Check observation budget exceeded");
          }
          const result = db
            .query(
              `INSERT INTO host_checks(invocationPosition,runId,nodeId,taskId,attempt,entry,id,severity,message,status,startedAt,owner) VALUES (?,?,?,?,?,?,?,?,?,'Running',?,?)`
            )
            .run(
              invocationPosition,
              identity.runId,
              identity.nodeId,
              identity.taskId,
              identity.attempt,
              identity.entry,
              input.id,
              input.severity,
              input.message,
              record.startedAt,
              lease.token
            );
          db.query(
            `INSERT INTO host_check_budget VALUES (?,1,?) ON CONFLICT(runId) DO UPDATE SET rows=rows+1,bytes=bytes+excluded.bytes`
          ).run(identity.runId, reserved);
          return Number(result.lastInsertRowid);
        })
        .immediate(),
  };
}

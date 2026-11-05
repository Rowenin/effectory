import type { Database } from "bun:sqlite";

import {
  LogListRequest,
  LogPayload,
  LogEntry,
  OutputListRequest,
  EventListRequest,
  WaitListRequest,
  WaitSummary,
} from "@effectory/runtime/history-protocol";
import { Event, OperationError } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import type { createPagination } from "./pagination.ts";

export function authorizeRun(
  database: Database,
  runId: string,
  principal: string
) {
  const row = database
    .query(
      "SELECT lastSequence FROM host_runs WHERE runId = ? AND principal = ?"
    )
    .get(runId, principal);
  if (!row) {
    throw new OperationError({
      code: "NotFound",
      message: "Run was not found",
    });
  }
  return Schema.decodeUnknownSync(Schema.Struct({ lastSequence: Schema.Int }))(
    row
  );
}
const EventRow = Schema.Struct({
  at: Schema.String,
  payloadJson: Schema.String,
  runId: Schema.String,
  sequence: Schema.Int,
  tag: Schema.String,
});

export function eventPage(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  value: typeof EventListRequest.Type,
  principal: string
) {
  const { cursor, afterSequence, ...query } = Schema.decodeUnknownSync(
    EventListRequest
  )(value, { onExcessProperty: "error" });
  const run = authorizeRun(database, query.runId, principal);
  if (cursor !== undefined && afterSequence !== undefined) {
    throw new OperationError({
      code: "InvalidInput",
      message: "Specify cursor or afterSequence, not both",
    });
  }
  const limit = query.limit ?? 50;
  const scope = { kind: "events", principal, query: { ...query, limit } };
  const token = pages.read(scope, cursor);
  const { lastSequence } = run;
  const snapshot = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.snapshot)
    : lastSequence;
  const after = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.position)
    : (afterSequence ?? 0);
  if (after > snapshot) {
    throw new OperationError({
      code: "InvalidInput",
      message: "Sequence exceeds recorded history",
    });
  }
  const statement = database.prepare(
    "SELECT at, payloadJson, runId, sequence, tag FROM host_events WHERE runId = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?"
  );
  const items: (typeof Event.Type)[] = [];
  let bytes = 0;
  let more = false;
  try {
    for (const raw of statement.iterate(
      query.runId,
      after,
      snapshot,
      limit + 1
    )) {
      const { payloadJson, ...row } = Schema.decodeUnknownSync(EventRow)(raw);
      const item = Schema.decodeUnknownSync(Event)({
        ...row,
        payload: JSON.parse(payloadJson),
      });
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (items.length >= limit || bytes > 1_048_576) {
        more = true;
        break;
      }
      items.push(item);
    }
  } finally {
    statement.finalize();
  }
  if (more && items.length === 0) {
    throw new OperationError({
      code: "LimitExceeded",
      message: "Event exceeds page byte limit",
    });
  }
  return {
    cursor: more
      ? pages.write(
          scope,
          snapshot,
          items.at(-1)?.sequence ?? after,
          token?.expires ?? Date.now() + 3_600_000
        )
      : null,
    items,
    snapshot,
  };
}

function waitMatches(
  query: typeof WaitListRequest.Type,
  status: string,
  row: typeof WaitSummary.Type
) {
  return (
    (query.kind === undefined || query.kind === row.kind) &&
    (status === "all" || status === row.status)
  );
}

/** Membership is fixed at opening; status and action availability are current. */
export function waitPage(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  value: typeof WaitListRequest.Type,
  principal: string
) {
  const { cursor, ...query } = Schema.decodeUnknownSync(WaitListRequest)(
    value,
    { onExcessProperty: "error" }
  );
  if (query.runId !== undefined) {
    authorizeRun(database, query.runId, principal);
  }
  const limit = query.limit ?? 50;
  const status = query.status ?? "Open";
  const scope = {
    kind: "waits",
    principal,
    query: { ...query, limit, status },
  };
  const token = pages.read(scope, cursor);
  const snapshot = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.snapshot)
    : Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Int }))(
        database
          .query(
            "SELECT COALESCE(MAX(w.rowid), 0) AS value FROM host_waits w JOIN host_runs r ON r.runId = w.runId WHERE r.principal = ?"
          )
          .get(principal)
      ).value;
  const after = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.position)
    : 0;
  const statement =
    database.prepare(`SELECT w.rowid AS position, w.waitId, w.runId, w.nodeId, w.kind, w.status, w.openedAt, w.deadline, w.prompt
    FROM host_waits w JOIN host_runs r ON r.runId = w.runId
    WHERE r.principal = ? AND w.rowid > ? AND w.rowid <= ?
      AND (? IS NULL OR w.runId = ?)
    ORDER BY w.rowid LIMIT 10001`);
  const items: (typeof WaitSummary.Type)[] = [];
  let position = after;
  let scanned = 0;
  let scannedBytes = 0;
  let bytes = 0;
  let more = false;
  try {
    for (const raw of statement.iterate(
      principal,
      after,
      snapshot,
      query.runId ?? null,
      query.runId ?? null
    )) {
      const row = Schema.decodeUnknownSync(WaitSummary)(raw);
      const size = Buffer.byteLength(JSON.stringify(row));
      scanned += 1;
      scannedBytes += size;
      if (scanned > 10_000 || scannedBytes > 16_777_216) {
        throw new OperationError({
          code: "QueryBudgetExceeded",
          message:
            "Wait page exceeded 10000 scanned rows or 16 MiB; narrow by run",
        });
      }
      if (!waitMatches(query, status, row)) {
        continue;
      }
      bytes += size;
      if (items.length >= limit || bytes > 1_048_576) {
        more = true;
        break;
      }
      items.push(row);
      const { position: nextPosition } = Schema.decodeUnknownSync(
        Schema.Struct({ position: Schema.Int })
      )(raw);
      position = nextPosition;
    }
  } finally {
    statement.finalize();
  }
  if (more && items.length === 0) {
    throw new OperationError({
      code: "LimitExceeded",
      message: "Wait description exceeds page byte limit",
    });
  }
  return {
    cursor: more
      ? pages.write(
          scope,
          snapshot,
          position,
          token?.expires ?? Date.now() + 3_600_000
        )
      : null,
    items,
    snapshot,
  };
}

function logMatches(
  query: typeof LogListRequest.Type,
  payload: typeof LogPayload.Type
) {
  return (
    (query.nodeId === undefined || query.nodeId === payload.nodeId) &&
    (query.level === undefined || query.level === payload.level)
  );
}

export function logPage(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  value: typeof LogListRequest.Type,
  principal: string
) {
  const { cursor, ...query } = Schema.decodeUnknownSync(LogListRequest)(value, {
    onExcessProperty: "error",
  });
  const { lastSequence } = authorizeRun(database, query.runId, principal);
  const limit = query.limit ?? 50;
  const scope = { kind: "logs", principal, query: { ...query, limit } };
  const token = pages.read(scope, cursor);
  const snapshot = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.snapshot)
    : lastSequence;
  const after = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.position)
    : 0;
  const statement = database.prepare(
    "SELECT at, payloadJson, runId, sequence, tag FROM host_events WHERE runId = ? AND tag = 'Log' AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 1001"
  );
  const items: (typeof LogEntry.Type)[] = [];
  let scanned = 0;
  let bytes = 0;
  let more = false;
  try {
    for (const raw of statement.iterate(query.runId, after, snapshot)) {
      scanned += 1;
      if (scanned > 1000) {
        throw new OperationError({
          code: "QueryBudgetExceeded",
          message: "Log scan budget exceeded",
        });
      }
      const { payloadJson, ...event } = Schema.decodeUnknownSync(EventRow)(raw);
      const payload = Schema.decodeUnknownSync(LogPayload)(
        JSON.parse(payloadJson)
      );
      if (!logMatches(query, payload)) {
        continue;
      }
      const item = Schema.decodeUnknownSync(LogEntry)({ ...event, ...payload });
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (items.length >= limit || bytes > 1_048_576) {
        more = true;
        break;
      }
      items.push(item);
    }
  } finally {
    statement.finalize();
  }
  return {
    cursor: more
      ? pages.write(
          scope,
          snapshot,
          items.at(-1)?.sequence ?? after,
          token?.expires ?? Date.now() + 3_600_000
        )
      : null,
    items,
    snapshot,
  };
}

export function invocationScan(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  value: typeof OutputListRequest.Type,
  principal: string
) {
  const { cursor, ...query } = Schema.decodeUnknownSync(OutputListRequest)(
    value,
    { onExcessProperty: "error" }
  );
  authorizeRun(database, query.runId, principal);
  const limit = query.limit ?? 50;
  const scope = { kind: "outputs", principal, query: { ...query, limit } };
  const token = pages.read(scope, cursor);
  const snapshot = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.snapshot)
    : Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Int }))(
        database
          .query(
            "SELECT COALESCE(MAX(rowid), 0) AS value FROM host_invocations WHERE runId = ?"
          )
          .get(query.runId)
      ).value;
  const after = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.position)
    : 0;
  const rows = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        engineId: Schema.String,
        nodeId: Schema.String,
        position: Schema.Int,
        taskId: Schema.String,
      })
    )
  )(
    database
      .query(`SELECT rowid AS position, nodeId, engineId, json_extract(payloadJson, '$.taskId') AS taskId
    FROM host_invocations WHERE runId = ? AND rowid > ? AND rowid <= ? AND (? IS NULL OR nodeId = ?)
    ORDER BY rowid LIMIT ?`)
      .all(
        query.runId,
        after,
        snapshot,
        query.nodeId ?? null,
        query.nodeId ?? null,
        limit + 1
      )
  );
  return {
    cursor: (position: number) =>
      pages.write(
        scope,
        snapshot,
        position,
        token?.expires ?? Date.now() + 3_600_000
      ),
    limit,
    rows,
    snapshot,
  };
}

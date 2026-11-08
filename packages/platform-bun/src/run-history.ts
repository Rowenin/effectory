import type { Database } from "bun:sqlite";

import {
  RunListRequest,
  RunSummary,
} from "@effectory/runtime/history-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { RunTags } from "@offtree/effectory-sdk/RunTags";
import { Schema } from "effect";

import type { createPagination } from "./pagination.ts";

const Position = Schema.Struct({
  acceptedAt: Schema.String,
  runId: Schema.String,
});
const timestamp = (value: string | undefined) => {
  if (value === undefined) {
    return null;
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new OperationError({
      code: "InvalidInput",
      message: "History timestamps must be ISO dates",
    });
  }
  return new Date(millis).toISOString();
};

function matches(
  query: typeof RunListRequest.Type,
  row: typeof RunSummary.Type
) {
  return (
    (query.targetId === undefined || query.targetId === row.targetId) &&
    (query.kind === undefined || query.kind === row.kind) &&
    (query.status === undefined || query.status === row.status)
  );
}
function readRows(
  database: Database,
  query: typeof RunListRequest.Type,
  principal: string,
  snapshot: number,
  position: typeof Position.Type | null,
  limit: number
) {
  const after = timestamp(query.createdAfter);
  const before = timestamp(query.createdBefore);
  const at = position?.acceptedAt ?? null;
  const tagEntries = Object.entries(query.tags ?? {}).toSorted(([a], [b]) =>
    a.localeCompare(b)
  );
  const tagPredicates = tagEntries
    .map(
      () =>
        "AND runId IN (SELECT runId FROM host_run_tags WHERE principal = ? AND key = ? AND value = ?)"
    )
    .join(" ");
  const statement =
    database.prepare(`SELECT runId, targetId, kind, revision, acceptedAt, status, lastSequence, scheduleJson, tagsJson, reportJson FROM host_runs
    WHERE principal = ? AND rowid <= ?
      AND (? IS NULL OR acceptedAt >= ?) AND (? IS NULL OR acceptedAt <= ?)
      AND (? IS NULL OR acceptedAt < ? OR (acceptedAt = ? AND runId > ?))
      AND (? IS NULL OR admissionLane = ?)
      ${tagPredicates}
    ORDER BY acceptedAt DESC, runId ASC LIMIT 10001`);
  const source = statement.iterate(
    principal,
    snapshot,
    after,
    after,
    before,
    before,
    at,
    at,
    at,
    position?.runId ?? null,
    query.origin === undefined || query.origin === "all" ? null : query.origin,
    query.origin === undefined || query.origin === "all" ? null : query.origin,
    ...tagEntries.flatMap(([key, value]) => [principal, key, value])
  );
  const rows: (typeof RunSummary.Type)[] = [];
  let scanned = 0;
  let bytes = 0;
  try {
    for (const value of source) {
      scanned += 1;
      const stored = Schema.decodeUnknownSync(
        Schema.Struct({
          ...RunSummary.fields,
          reportJson: Schema.NullOr(Schema.String),
          scheduleJson: Schema.NullOr(Schema.String),
          tagsJson: Schema.String,
        })
      )(value);
      const row = Schema.decodeUnknownSync(RunSummary)({
        ...stored,
        tags: Schema.decodeUnknownSync(RunTags)(JSON.parse(stored.tagsJson)),
        ...(stored.reportJson === null
          ? {}
          : { report: JSON.parse(stored.reportJson) }),
        ...(stored.scheduleJson === null
          ? {}
          : { schedule: JSON.parse(stored.scheduleJson) }),
      });
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (scanned > 10_000 || bytes > 16_777_216) {
        throw new OperationError({
          code: "QueryBudgetExceeded",
          message:
            "History page exceeded 10000 scanned rows or 16 MiB; narrow the time range",
        });
      }
      if (matches(query, row)) {
        rows.push(row);
      }
      if (rows.length > limit) {
        break;
      }
    }
  } finally {
    statement.finalize();
  }
  return rows;
}

/** Membership excludes later admissions; each row shows its current projected status. */
export function runHistory(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  value: typeof RunListRequest.Type,
  principal: string
) {
  const { cursor, tags, ...rest } = Schema.decodeUnknownSync(RunListRequest)(
    value,
    {
      onExcessProperty: "error",
    }
  );
  const query = {
    ...rest,
    ...(tags && Object.keys(tags).length ? { tags } : {}),
  };
  const limit = query.limit ?? 50;
  const scope = { kind: "runs", principal, query: { ...query, limit } };
  const token = pages.read(scope, cursor);
  const snapshot = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.snapshot)
    : Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Int }))(
        database
          .query(
            "SELECT COALESCE(MAX(rowid), 0) AS value FROM host_runs WHERE principal = ?"
          )
          .get(principal)
      ).value;
  const position =
    token === null ? null : Schema.decodeUnknownSync(Position)(token.position);
  const rows = readRows(database, query, principal, snapshot, position, limit);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    cursor:
      rows.length > limit && last
        ? pages.write(
            scope,
            snapshot,
            { acceptedAt: last.acceptedAt, runId: last.runId },
            token?.expires ?? Date.now() + 3_600_000
          )
        : null,
    items,
    snapshot,
  };
}

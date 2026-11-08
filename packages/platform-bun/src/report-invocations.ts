import type { Database } from "bun:sqlite";

import { PageRequest } from "@offtree/effectory-sdk/internal/report-history";
import { Schema } from "effect";

import { authorizeRun } from "./inspection.ts";
import type { createPagination } from "./pagination.ts";

/** Select bounded previews in SQLite, never copy a potentially huge invocation path. */
export function reportInvocationScan(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  runId: string,
  principal: string,
  request: PageRequest
) {
  const { cursor, ...query } = Schema.decodeSync(PageRequest)(request, {
    onExcessProperty: "error",
  });
  authorizeRun(database, runId, principal);
  const limit = query.limit ?? 50;
  const scope = {
    kind: "report-invocations",
    principal,
    query: { limit, runId },
  };
  const token = pages.read(scope, cursor);
  const snapshot = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.snapshot)
    : Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Int }))(
        database
          .query(
            "SELECT COALESCE(MAX(rowid),0) AS value FROM host_invocations WHERE runId = ?"
          )
          .get(runId)
      ).value;
  const after = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.position)
    : 0;
  const rows = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        attemptCount: Schema.Int,
        engineId: Schema.String,
        pathText: Schema.String,
        position: Schema.Int,
        taskId: Schema.String,
      })
    )
  )(
    database
      .query(`SELECT i.rowid AS position, i.engineId, substr(i.nodeId,1,2049) AS pathText, json_extract(i.payloadJson,'$.taskId') AS taskId,
    (SELECT COUNT(*) FROM host_attempts a WHERE a.runId = i.runId AND a.nodeId = i.nodeId) AS attemptCount
    FROM host_invocations i WHERE i.runId = ? AND i.rowid > ? AND i.rowid <= ? ORDER BY i.rowid LIMIT ?`)
      .all(runId, after, snapshot, limit + 1)
  );
  return {
    after,
    cursor: (position: number) =>
      pages.write(
        scope,
        snapshot,
        position,
        token?.expires ?? Date.now() + 3_600_000
      ),
    limit,
    more: false,
    position: rows.at(-1)?.position ?? after,
    rows,
    snapshot,
  };
}

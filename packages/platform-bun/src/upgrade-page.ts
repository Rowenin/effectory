import type { Database } from "bun:sqlite";

import { OperationError } from "@effectory/runtime/protocol";

const maximumPageBytes = 8_388_608;

/**
 * Called inside the scanner's short synchronous transaction. Inspect SQL value
 * lengths before materializing a page in JavaScript. Shrink dense pages; reject
 * a single oversized journal row. Statements are finalized even on failure, so
 * no iterator/read snapshot escapes the transaction or an Effect yield.
 * SQL and its projected column names are host-owned, never operator input.
 */
export function upgradePage(
  database: Database,
  sql: string,
  after: readonly number[]
) {
  const statement = database.prepare(sql);
  try {
    const columns = statement.columnNames;
    if (
      columns.length === 0 ||
      columns.length > 64 ||
      new Set(columns).size !== columns.length
    ) {
      throw new Error("Invalid upgrade page projection");
    }
    const size = columns
      .map((name) => {
        const field = `p."${name.replaceAll('"', '""')}"`;
        return `CASE WHEN typeof(${field}) IN ('text','blob') THEN octet_length(${field}) ELSE 16 END`;
      })
      .join("+");
    const measure = database.prepare<{ bytes: number; rows: number }, number[]>(
      `SELECT count(*) rows, COALESCE(sum(${size}),0) bytes FROM (${sql}) p`
    );
    try {
      let limit = 200;
      for (;;) {
        const args = [...after, limit];
        const stats = measure.get(...args);
        if (
          stats === null ||
          !Number.isSafeInteger(stats.bytes) ||
          !Number.isSafeInteger(stats.rows) ||
          stats.bytes < 0 ||
          stats.rows < 0 ||
          stats.rows > limit
        ) {
          throw new Error("Invalid upgrade page size");
        }
        if (stats.bytes <= maximumPageBytes) {
          return { more: stats.rows === limit, rows: statement.all(...args) };
        }
        if (limit === 1) {
          throw new OperationError({
            code: "LimitExceeded",
            message:
              "An upgrade inspection row exceeds 8 MiB; complete work with its compatible host before upgrading",
          });
        }
        limit = Math.max(1, Math.floor(limit / 2));
      }
    } finally {
      measure.finalize();
    }
  } finally {
    statement.finalize();
  }
}

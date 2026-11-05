import type { Database } from "bun:sqlite";

import {
  ExtensionOperation,
  OperationListRequest,
} from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import type { createPagination } from "./pagination.ts";

function matches(
  query: typeof OperationListRequest.Type,
  operation: typeof ExtensionOperation.Type
) {
  return (
    (query.kind === undefined || query.kind === operation.kind) &&
    (query.status === undefined || query.status === operation.status)
  );
}

export function operationHistory(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  value: typeof OperationListRequest.Type,
  actor: string
) {
  const { cursor, afterSequence, ...query } = Schema.decodeUnknownSync(
    OperationListRequest
  )(value, { onExcessProperty: "error" });
  if (cursor !== undefined && afterSequence !== undefined) {
    throw new OperationError({
      code: "InvalidInput",
      message: "Specify cursor or afterSequence, not both",
    });
  }
  const limit = query.limit ?? 50;
  const scope = {
    kind: "operations",
    principal: actor,
    query: { ...query, limit },
  };
  const token = pages.read(scope, cursor);
  const snapshot = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.snapshot)
    : Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Int }))(
        database
          .query(
            "SELECT COALESCE(MAX(sequence), 0) AS value FROM extension_operations WHERE actor = ?"
          )
          .get(actor)
      ).value;
  const after = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.position)
    : (afterSequence ?? 0);
  const statement = database.prepare(
    "SELECT snapshotJson FROM extension_operations WHERE actor = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 10001"
  );
  const items: (typeof ExtensionOperation.Type)[] = [];
  let bytes = 0;
  let scanned = 0;
  let more = false;
  try {
    for (const raw of statement.iterate(actor, after, snapshot)) {
      scanned += 1;
      const { snapshotJson } = Schema.decodeUnknownSync(
        Schema.Struct({ snapshotJson: Schema.String })
      )(raw);
      bytes += Buffer.byteLength(snapshotJson);
      if (scanned > 10_000 || bytes > 1_048_576) {
        throw new OperationError({
          code: "QueryBudgetExceeded",
          message: "Operation page exceeded its scan budget",
        });
      }
      const operation = Schema.decodeUnknownSync(ExtensionOperation)(
        JSON.parse(snapshotJson)
      );
      if (!matches(query, operation)) {
        continue;
      }
      if (items.length >= limit) {
        more = true;
        break;
      }
      items.push(operation);
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

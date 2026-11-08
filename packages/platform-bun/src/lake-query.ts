import type { Database } from "bun:sqlite";

import {
  Query,
  QueryPage,
  Record as ArtifactRecord,
} from "@effectory/runtime/lake-protocol";
import type { QueryRow } from "@effectory/runtime/lake-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import {
  FieldDescriptions,
  makeQueryEvaluator,
} from "@offtree/effectory-sdk/internal/artifact-query-evaluator";
import type { Row } from "@offtree/effectory-sdk/internal/artifact-query-evaluator";
import { checkJsonBudget } from "@offtree/effectory-sdk/internal/boundary";
import { Schema } from "effect";

import { queryCandidates } from "./lake-query-candidates.ts";
import { cursorSnapshot, reclamationEpoch } from "./lake-retention-store.ts";
import type { createPagination } from "./pagination.ts";

const Stored = Schema.Struct({
  fieldsJson: Schema.String,
  metadataJson: Schema.String,
});
const invalid = (message: string) =>
  new OperationError({ code: "InvalidInput", message });
const { matches, order, project, validate } = makeQueryEvaluator(
  (code, message) => new OperationError({ code, message })
);
const budget = () =>
  new OperationError({
    code: "QueryBudgetExceeded",
    message:
      "Query exceeded 10000 scanned rows, 16 MiB of metadata, or 250 ms; narrow the artifact scope",
  });

function scanRows(
  database: Database,
  query: Query,
  principal: string,
  snapshot: number,
  started: number
) {
  const candidates = queryCandidates(query.where);
  const latest =
    query.versions === "latest"
      ? "AND NOT EXISTS (SELECT 1 FROM lake_records newer WHERE newer.principal = r.principal AND newer.artifactId = r.artifactId AND newer.sequence <= ? AND newer.reclaimedAt IS NULL AND newer.version > r.version)"
      : "";
  const statement =
    database.prepare(`SELECT r.metadataJson, r.fieldsJson FROM lake_records r
    WHERE r.reclaimedAt IS NULL AND r.principal = ? AND r.schemaId = ? AND r.schemaVersion = ? AND r.sequence <= ? ${latest} ${candidates.clause} ORDER BY r.sequence LIMIT 10001`);
  let scanned = 0;
  let scannedBytes = 0;
  const matched: Row[] = [];
  try {
    for (const raw of statement.iterate(
      principal,
      query.artifact.schemaId,
      query.artifact.schemaVersion,
      snapshot,
      ...(query.versions === "latest" ? [snapshot] : []),
      ...candidates.values
    )) {
      scanned += 1;
      const stored = Schema.decodeUnknownSync(Stored)(raw);
      scannedBytes +=
        Buffer.byteLength(stored.metadataJson) +
        Buffer.byteLength(stored.fieldsJson);
      if (
        scanned > 10_000 ||
        scannedBytes > 16_777_216 ||
        performance.now() - started > 250
      ) {
        throw budget();
      }
      const row = {
        fields: Schema.decodeUnknownSync(
          Schema.Record(Schema.String, Schema.Json)
        )(JSON.parse(stored.fieldsJson)),
        record: Schema.decodeUnknownSync(ArtifactRecord)(
          JSON.parse(stored.metadataJson)
        ),
      };
      if (query.where === undefined || matches(query.where, row)) {
        matched.push(row);
      }
    }
  } finally {
    statement.finalize();
  }
  return { matched, scanned, scannedBytes };
}

function selectRows(query: Query, source: readonly Row[]) {
  const rows: QueryRow[] = [];
  let more = false;
  let bytes = 0;
  for (const row of source) {
    const projected = project(query, row);
    checkJsonBudget(projected, {
      bytes: 2_097_152,
      depth: 64,
      values: 100_000,
    });
    bytes += Buffer.byteLength(JSON.stringify(projected));
    if (rows.length >= query.limit || bytes > 2_097_152) {
      more = true;
      break;
    }
    rows.push(projected);
  }
  if (more && rows.length === 0) {
    throw new OperationError({
      code: "LimitExceeded",
      message: "Projected row exceeds 2 MiB page limit",
    });
  }
  return { more, rows };
}

function decodeQuery(request: Query) {
  checkJsonBudget(request, { bytes: 65_536, depth: 24, values: 4096 });
  try {
    return Schema.decodeUnknownSync(Query)(request, {
      onExcessProperty: "error",
    });
  } catch {
    throw invalid("Query shape, version, field or page limit is invalid");
  }
}

export function lakeQuery(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  request: Query,
  principal: string,
  cursor?: string,
  validateRequest: typeof validate = validate
) {
  const query = decodeQuery(request);
  const started = performance.now();
  const scope = {
    kind: "lake",
    principal,
    query: Schema.decodeUnknownSync(Schema.Json)(query),
  };
  const token = pages.read(scope, cursor);
  const epoch = reclamationEpoch(database, principal);
  const snapshot = token
    ? cursorSnapshot(token.snapshot, epoch, "sequence")
    : Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Int }))(
        database
          .query(
            "SELECT COALESCE(MAX(sequence), 0) AS value FROM lake_records WHERE principal = ?"
          )
          .get(principal)
      ).value;
  const after = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.position)
    : 0;
  const schema = database
    .query(
      "SELECT fieldsJson FROM lake_schemas WHERE schemaId = ? AND version = ?"
    )
    .get(query.artifact.schemaId, query.artifact.schemaVersion);
  const descriptions = schema
    ? Schema.decodeUnknownSync(FieldDescriptions)(
        JSON.parse(
          Schema.decodeUnknownSync(
            Schema.Struct({ fieldsJson: Schema.String })
          )(schema).fieldsJson
        )
      )
    : [];
  validateRequest(query, descriptions);
  const { matched, scanned, scannedBytes } = scanRows(
    database,
    query,
    principal,
    snapshot,
    started
  );
  matched.sort((left, right) => order(query, left, right));
  if (performance.now() - started > 250) {
    throw budget();
  }
  const index =
    after === 0
      ? -1
      : matched.findIndex((row) => row.record.sequence === after);
  if (after !== 0 && index < 0) {
    throw new OperationError({
      code: "CursorExpired",
      message: "Query snapshot row is unavailable",
    });
  }
  const { rows, more } = selectRows(query, matched.slice(index + 1));
  return QueryPage.make({
    cursor: more
      ? pages.write(
          scope,
          { epoch, value: snapshot },
          rows.at(-1)?.sequence ?? after,
          token?.expires ?? Date.now() + 3_600_000
        )
      : null,
    matched: matched.length,
    rows,
    scanned,
    scannedBytes,
    snapshot,
  });
}

import type { Database } from "bun:sqlite";

import {
  VersionListRequest,
  Record as ArtifactRecord,
} from "@effectory/runtime/lake-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import type { createPagination } from "./pagination.ts";

export function lakeVersions(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  value: typeof VersionListRequest.Type,
  principal: string
) {
  const { cursor, ...query } = Schema.decodeUnknownSync(VersionListRequest)(
    value,
    { onExcessProperty: "error" }
  );
  const latest = Schema.decodeUnknownSync(
    Schema.Struct({ value: Schema.NullOr(Schema.Int) })
  )(
    database
      .query(
        "SELECT MAX(version) AS value FROM lake_records WHERE principal = ? AND artifactId = ?"
      )
      .get(principal, query.artifactId)
  ).value;
  if (latest === null) {
    throw new OperationError({
      code: "NotFound",
      message: "Artifact was not found",
    });
  }
  const limit = query.limit ?? 50;
  const scope = {
    kind: "lake-versions",
    principal,
    query: { ...query, limit },
  };
  const token = pages.read(scope, cursor);
  const snapshot = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.snapshot)
    : latest;
  const after = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.position)
    : 0;
  const statement = database.prepare(
    "SELECT metadataJson FROM lake_records WHERE principal = ? AND artifactId = ? AND version > ? AND version <= ? ORDER BY version LIMIT ?"
  );
  const items: ArtifactRecord[] = [];
  let bytes = 0;
  let more = false;
  try {
    for (const raw of statement.iterate(
      principal,
      query.artifactId,
      after,
      snapshot,
      limit + 1
    )) {
      const { metadataJson } = Schema.decodeUnknownSync(
        Schema.Struct({ metadataJson: Schema.String })
      )(raw);
      bytes += Buffer.byteLength(metadataJson);
      if (items.length >= limit || bytes > 1_048_576) {
        more = true;
        break;
      }
      items.push(
        Schema.decodeUnknownSync(ArtifactRecord)(JSON.parse(metadataJson))
      );
    }
  } finally {
    statement.finalize();
  }
  if (more && items.length === 0) {
    throw new OperationError({
      code: "LimitExceeded",
      message: "Artifact metadata exceeds page budget",
    });
  }
  return {
    cursor: more
      ? pages.write(
          scope,
          snapshot,
          items.at(-1)?.version ?? after,
          token?.expires ?? Date.now() + 3_600_000
        )
      : null,
    items,
    snapshot,
  };
}

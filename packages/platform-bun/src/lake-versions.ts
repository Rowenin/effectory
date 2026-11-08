import type { Database } from "bun:sqlite";

import type { VersionPage } from "@effectory/runtime/lake-protocol";
import {
  VersionListRequest,
  Record as ArtifactRecord,
} from "@effectory/runtime/lake-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { versionProtection } from "./lake-protection.ts";
import { cursorSnapshot, reclamationEpoch } from "./lake-retention-store.ts";
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
  const limit = query.limit ?? 50;
  const scope = {
    kind: "lake-versions",
    principal,
    query: { ...query, limit },
  };
  // Authorize against historical identity before inspecting another actor's cursor.
  if (
    !database
      .query(
        "SELECT 1 FROM lake_records WHERE principal = ? AND artifactId = ? LIMIT 1"
      )
      .get(principal, query.artifactId)
  ) {
    throw new OperationError({
      code: "NotFound",
      message: "Artifact was not found",
    });
  }
  const token = pages.read(scope, cursor);
  const epoch = reclamationEpoch(database, principal);
  const previousSnapshot = token
    ? cursorSnapshot(token.snapshot, epoch, "version")
    : undefined;
  const retained = query.includeReclaimed ? "" : "AND reclaimedAt IS NULL";
  const latest = Schema.decodeUnknownSync(
    Schema.Struct({ value: Schema.NullOr(Schema.Int) })
  )(
    database
      .query(
        `SELECT MAX(version) AS value FROM lake_records WHERE principal = ? AND artifactId = ? ${retained}`
      )
      .get(principal, query.artifactId)
  ).value;
  if (latest === null) {
    throw new OperationError({
      code: "NotFound",
      message: "Artifact was not found",
    });
  }
  const snapshot = previousSnapshot ?? latest;
  const after = token
    ? Schema.decodeUnknownSync(Schema.Int)(token.position)
    : 0;
  const statement = database.prepare(
    `SELECT metadataJson,reclaimedAt,reclamationPlanId FROM lake_records WHERE principal = ? AND artifactId = ? AND version > ? AND version <= ? ${retained} ORDER BY version LIMIT ?`
  );
  const items: (typeof VersionPage.Type)["items"][number][] = [];
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
      const { metadataJson, reclaimedAt, reclamationPlanId } =
        Schema.decodeUnknownSync(
          Schema.Struct({
            metadataJson: Schema.String,
            reclaimedAt: Schema.NullOr(Schema.String),
            reclamationPlanId: Schema.NullOr(Schema.String),
          })
        )(raw);
      bytes += Buffer.byteLength(metadataJson);
      if (items.length >= limit || bytes > 1_048_576) {
        more = true;
        break;
      }
      const record = Schema.decodeUnknownSync(ArtifactRecord)(
        JSON.parse(metadataJson)
      );
      items.push({
        ...record,
        ...(reclaimedAt === null
          ? { protection: versionProtection(database, record.sequence) }
          : {}),
        ...(reclaimedAt === null
          ? {}
          : {
              reclaimedAt,
              reclamationPlanId: Schema.decodeUnknownSync(Schema.String)(
                reclamationPlanId
              ),
            }),
      });
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
          { epoch, value: snapshot },
          items.at(-1)?.version ?? after,
          token?.expires ?? Date.now() + 3_600_000
        )
      : null,
    items,
    snapshot,
  };
}

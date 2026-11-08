/* oxlint-disable no-bitwise -- POSIX no-follow descriptor flags. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import type { Artifact, Task } from "@offtree/effectory-sdk";
import type { Metadata } from "@offtree/effectory-sdk/ArtifactReader";
import { makeQueryEvaluator } from "@offtree/effectory-sdk/internal/artifact-query-evaluator";
import {
  Record as ArtifactRecord,
  Query,
} from "@offtree/effectory-sdk/internal/artifact-query-schema";
import {
  ArtifactReadError,
  ArtifactUnavailable,
  readFailure,
} from "@offtree/effectory-sdk/internal/artifact-read-errors";
import type { ReadError } from "@offtree/effectory-sdk/internal/artifact-read-errors";
import {
  checkReference,
  referenceFor,
  readerRuntime,
} from "@offtree/effectory-sdk/internal/artifact-reader-runtime";
import type { ReaderBackend } from "@offtree/effectory-sdk/internal/artifact-reader-runtime";
import { binaryOwner } from "@offtree/effectory-sdk/internal/binary-admission";
import type { BinaryPool } from "@offtree/effectory-sdk/internal/binary-admission";
import {
  canonical,
  identifier,
} from "@offtree/effectory-sdk/internal/boundary";
import { Effect, Schema, Stream } from "effect";

import { attemptEntry } from "./attempt-entry.ts";
import { binaryDownload } from "./lake-download.ts";
import { reportHolds, unsettledReports } from "./lake-protection.ts";
import { lakeQuery } from "./lake-query.ts";
import type { Lease } from "./ownership.ts";
import type { createPagination } from "./pagination.ts";

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const codeOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null
    ? Reflect.get(error, "code")
    : undefined;
const convert = (error: unknown): ReadError => {
  if (
    error instanceof ArtifactReadError ||
    error instanceof ArtifactUnavailable
  ) {
    return error;
  }
  if (codeOf(error) === "SQLITE_BUSY" || codeOf(error) === "SQLITE_LOCKED") {
    return new ArtifactUnavailable({
      message: "Artifact storage is busy",
      reason: "Busy",
    });
  }
  if (error instanceof OperationError) {
    if (error.code === "Unavailable" || error.code === "StorageFull") {
      return new ArtifactUnavailable({
        message: "Artifact storage is unavailable",
        reason: "Storage",
      });
    }
    if (error.code === "CursorExpired") {
      return readFailure("CursorExpired");
    }
    if (
      error.code === "QueryBudgetExceeded" ||
      error.code === "LimitExceeded"
    ) {
      return readFailure("QueryBudget");
    }
    if (error.code === "Conflict") {
      return readFailure("InvalidCursor");
    }
    if (error.code === "InvalidInput") {
      return readFailure("InvalidQuery");
    }
    if (error.code === "NotFound") {
      return readFailure("NotFound");
    }
    if (error.code === "ContentUnavailable") {
      return readFailure("Corrupt");
    }
  }
  if (
    [
      "EIO",
      "EMFILE",
      "ENFILE",
      "EACCES",
      "ENOSPC",
      "SQLITE_IOERR",
      "SQLITE_FULL",
    ].includes(String(codeOf(error)))
  ) {
    return new ArtifactUnavailable({
      message: "Artifact storage is unavailable",
      reason: "Storage",
    });
  }
  return readFailure("Corrupt");
};
/** Busy waits occur outside every SQLite transaction and content permit. */
function perform<A>(body: () => A) {
  return Effect.gen(function* () {
    for (let tries = 0; ; tries += 1) {
      const result = yield* Effect.try({ catch: convert, try: body }).pipe(
        Effect.result
      );
      if (result._tag === "Success") {
        return result.success;
      }
      const error = result.failure;
      if (
        !(error instanceof ArtifactUnavailable) ||
        error.reason !== "Busy" ||
        tries >= 25
      ) {
        return yield* error;
      }
      yield* Effect.sleep("10 millis");
    }
  });
}
export function createReader(
  database: Database,
  directory: string,
  lease: Lease,
  pages: ReturnType<typeof createPagination>,
  pool: BinaryPool,
  identity: Task.Identity,
  active: () => boolean
) {
  const authorize = () => {
    try {
      lease.assertActive();
    } catch {
      throw readFailure("Closed");
    }
    if (!active()) {
      throw readFailure("Closed");
    }
    const raw = database
      .query(`SELECT r.principal FROM host_runs r JOIN host_attempts a ON a.runId=r.runId
      WHERE r.runId=? AND a.nodeId=? AND a.activityAttempt=? AND a.owner=?
      AND r.status IN ('Queued','Running','Waiting','Retrying','NeedsAttention')
      AND (? IS NULL OR a.entries=?)
      AND NOT EXISTS(SELECT 1 FROM host_fences f WHERE f.runId=r.runId)`)
      .get(
        identity.runId,
        identity.invocationPath,
        identity.attempt,
        lease.token,
        attemptEntry(identity) ?? null,
        attemptEntry(identity) ?? null
      );
    if (raw === null) {
      throw readFailure("Closed");
    }
    return Schema.decodeUnknownSync(
      Schema.Struct({ principal: Schema.String })
    )(raw).principal;
  };
  const lookup = (
    ref: Pick<Artifact.Reference, "artifactId" | "version">,
    principal: string
  ): Metadata => {
    if (
      !/^[a-f0-9]{64}$/u.test(ref.artifactId) ||
      !Number.isSafeInteger(ref.version) ||
      ref.version < 1
    ) {
      throw readFailure("NotFound", ref);
    }
    const raw = database
      .query(
        "SELECT metadataJson,reclaimedAt FROM lake_records WHERE principal=? AND artifactId=? AND version=?"
      )
      .get(principal, ref.artifactId, ref.version);
    if (raw === null) {
      throw readFailure("NotFound", ref);
    }
    const row = Schema.decodeUnknownSync(
      Schema.Struct({
        metadataJson: Schema.String,
        reclaimedAt: Schema.NullOr(Schema.String),
      })
    )(raw);
    if (row.reclaimedAt !== null) {
      throw readFailure("Reclaimed", ref);
    }
    const record = Schema.decodeUnknownSync(ArtifactRecord)(
      JSON.parse(row.metadataJson)
    );
    return {
      ...record,
      contentType: record.contentType ?? "application/json",
      kind: record.kind ?? "json",
    };
  };
  const pin = (record: Metadata) => {
    if (record.runId === identity.runId) {
      return;
    }
    if (
      database
        .query(`SELECT 1 FROM host_reports r JOIN host_report_groups g ON g.groupId=r.groupId
      WHERE r.reportRunId=? AND g.sourceRunId=? AND r.status IN (${unsettledReports})`)
        .get(identity.runId, record.runId) !== null &&
      reportHolds(database, record.runId)
    ) {
      return;
    }
    if (
      database
        .query(
          "SELECT 1 FROM lake_consumer_pins WHERE consumerRunId=? AND sequence=?"
        )
        .get(identity.runId, record.sequence) !== null
    ) {
      return;
    }
    const { value } = Schema.decodeUnknownSync(
      Schema.Struct({ value: Schema.Int })
    )(
      database
        .query(
          "SELECT COUNT(*) AS value FROM lake_consumer_pins WHERE consumerRunId=?"
        )
        .get(identity.runId)
    );
    if (value >= 1024) {
      throw readFailure("PinLimit", record);
    }
    database
      .query("INSERT INTO lake_consumer_pins VALUES (?,?)")
      .run(identity.runId, record.sequence);
  };
  const backend: ReaderBackend = {
    json: (record) =>
      perform(() => {
        const current = lookup(record, authorize());
        if (
          current.bytes < 0 ||
          current.bytes > 1_048_576 ||
          !/^[a-f0-9]{64}$/u.test(current.digest)
        ) {
          throw readFailure("Corrupt", record);
        }
        const fd = openSync(
          path.join(directory, current.digest),
          constants.O_RDONLY | constants.O_NOFOLLOW
        );
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size !== current.bytes) {
            throw readFailure("Corrupt", record);
          }
          const bytes = readFileSync(fd);
          if (sha256(bytes) !== current.digest) {
            throw readFailure("Corrupt", record);
          }
          return Schema.decodeUnknownSync(Schema.Json)(
            JSON.parse(bytes.toString("utf-8"))
          );
        } finally {
          closeSync(fd);
        }
      }),
    latest: (artifact, identityKey) =>
      perform(() =>
        database
          .transaction(() => {
            const principal = authorize();
            try {
              identifier(identityKey.taskId);
              identifier(identityKey.output);
              identifier(identityKey.key);
            } catch {
              throw readFailure("InvalidQuery");
            }
            const artifactId = sha256(
              canonical([
                principal,
                identityKey.taskId,
                identityKey.output,
                identityKey.key,
              ])
            );
            const row = database
              .query(
                "SELECT version FROM lake_records WHERE principal=? AND artifactId=? AND reclaimedAt IS NULL ORDER BY version DESC LIMIT 1"
              )
              .get(principal, artifactId);
            if (row === null) {
              const historical = database
                .query(
                  "SELECT 1 FROM lake_records WHERE principal=? AND artifactId=? LIMIT 1"
                )
                .get(principal, artifactId);
              throw readFailure(
                historical === null ? "NotFound" : "Reclaimed",
                {
                  artifactId,
                }
              );
            }
            const { version } = Schema.decodeUnknownSync(
              Schema.Struct({ version: Schema.Int })
            )(row);
            const record = lookup({ artifactId, version }, principal);
            const ref = referenceFor(record);
            checkReference(artifact, ref, record);
            pin(record);
            return ref;
          })
          .immediate()
      ),
    query: (artifact, options) =>
      perform(() => {
        const principal = authorize();
        const { cursor, ...rest } = options;
        let query: Query;
        try {
          query = Schema.decodeUnknownSync(Query)(
            {
              ...rest,
              artifact: {
                schemaId: artifact.id,
                schemaVersion: artifact.version,
              },
              limit: options.limit ?? 50,
              version: 1,
            },
            { onExcessProperty: "error" }
          );
        } catch {
          throw readFailure("InvalidQuery");
        }
        if (
          cursor !== undefined &&
          (typeof cursor !== "string" || cursor.length > 4096)
        ) {
          throw readFailure("InvalidCursor");
        }
        if (cursor !== undefined) {
          try {
            pages.read(
              {
                kind: "lake",
                principal,
                query: Schema.decodeUnknownSync(Schema.Json)(query),
              },
              cursor
            );
          } catch (error) {
            if (
              error instanceof OperationError &&
              error.code === "CursorExpired"
            ) {
              throw readFailure("CursorExpired");
            }
            throw readFailure("InvalidCursor");
          }
        }
        const page = database.transaction(() =>
          lakeQuery(
            database,
            pages,
            query,
            principal,
            cursor,
            makeQueryEvaluator(() => readFailure("InvalidQuery")).validate
          )
        )();
        return {
          ...page,
          rows: page.rows.map((row) => {
            const { projection, ...record } = row;
            const metadata: Metadata = {
              ...record,
              contentType: row.contentType ?? "application/json",
              kind: row.kind ?? "json",
            };
            return {
              metadata,
              ref: referenceFor(metadata),
              ...(projection === undefined ? {} : { projection }),
            };
          }),
        };
      }),
    resolve: (artifact, ref) =>
      perform(() =>
        database
          .transaction(() => {
            const record = lookup(ref, authorize());
            checkReference(artifact, ref, record);
            pin(record);
            return record;
          })
          .immediate()
      ),
    stream: (record) =>
      binaryDownload(
        directory,
        () => lookup(record, authorize()),
        convert
      ).pipe(
        Stream.filter(
          (frame): frame is Extract<typeof frame, { _tag: "Bytes" }> =>
            frame._tag === "Bytes"
        ),
        Stream.map((frame) => frame.bytes),
        Stream.mapError(convert)
      ),
  };
  return readerRuntime(backend, binaryOwner(pool));
}

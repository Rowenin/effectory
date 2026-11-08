import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  Content,
  Record as ArtifactRecord,
} from "@effectory/runtime/lake-protocol";
import type {
  Query,
  VersionListRequest,
} from "@effectory/runtime/lake-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import type { Artifact, Task } from "@offtree/effectory-sdk";
import { TaskRuntimeError } from "@offtree/effectory-sdk";
import { binaryPool } from "@offtree/effectory-sdk/internal/binary-admission";
import {
  canonical,
  decode,
  checkJsonBudget,
  jsonLimits,
} from "@offtree/effectory-sdk/internal/boundary";
import { Context, Effect, Layer, Schema } from "effect";
import type { Stream } from "effect";

import { attemptEntry } from "./attempt-entry.ts";
import { HostStore } from "./host-store.ts";
import { createAutomaticRetention } from "./lake-automatic.ts";
import { createBinaryStorage, initializeBinaryStorage } from "./lake-binary.ts";
import { binaryDownload } from "./lake-download.ts";
import {
  cleanupReadPins,
  initializeReadProtection,
} from "./lake-protection.ts";
import { initializeQueryIndexes } from "./lake-query-candidates.ts";
import { lakeQuery } from "./lake-query.ts";
import { createReader } from "./lake-reader.ts";
import { createReclamation, resumeReclamation } from "./lake-reclamation.ts";
import { initializeRetention } from "./lake-retention-store.ts";
import { lakeVersions } from "./lake-versions.ts";
import { RepositoryLease } from "./ownership.ts";
import type { Lease } from "./ownership.ts";
import { createPagination } from "./pagination.ts";
import { storageError } from "./storage-error.ts";

const maximumBytes = 1_048_576;
const Stored = Schema.Struct({
  fieldsJson: Schema.String,
  metadataJson: Schema.String,
});
const countRow = Schema.Struct({ value: Schema.Int });
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const parseJson = (value: string) =>
  Schema.decodeUnknownSync(Schema.Json)(JSON.parse(value));
const fail = (code: OperationError["code"], message: string) =>
  new OperationError({ code, message });

function atomicBlob(directory: string, digest: string, bytes: string) {
  const destination = path.join(directory, digest);
  if (existsSync(destination)) {
    if (sha256(readFileSync(destination)) !== digest) {
      throw fail("ContentUnavailable", "Existing artifact content is corrupt");
    }
    return;
  }
  const temporary = path.join(directory, `.pending-${crypto.randomUUID()}`);
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    const file = openSync(temporary, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, destination);
    const folder = openSync(directory, "r");
    try {
      fsyncSync(folder);
    } finally {
      closeSync(folder);
    }
  } finally {
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
  }
}

function projectedFields(artifact: Artifact.Artifact, value: Schema.Json) {
  const fields: Record<string, Schema.Json> = {};
  for (const field of artifact.fields) {
    let current: unknown = value;
    for (const key of field) {
      current =
        typeof current === "object" &&
        current !== null &&
        Object.hasOwn(current, key)
          ? Reflect.get(current, key)
          : undefined;
    }
    if (current !== undefined) {
      fields[JSON.stringify(field)] = Schema.decodeUnknownSync(Schema.Json)(
        current
      );
    }
  }
  return fields;
}

const normalizeRecord = <A extends ArtifactRecord>(record: A) => ({
  ...record,
  contentType: record.contentType ?? "application/json",
  kind: record.kind ?? "json",
});

const metadata = (raw: unknown) => {
  const stored = Schema.decodeUnknownSync(Stored)(raw);
  return {
    fields: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      JSON.parse(stored.fieldsJson)
    ),
    record: normalizeRecord(
      Schema.decodeUnknownSync(ArtifactRecord)(JSON.parse(stored.metadataJson))
    ),
  };
};

const reference = (record: ArtifactRecord): Artifact.Reference => ({
  artifactId: record.artifactId,
  digest: record.digest,
  schemaId: record.schemaId,
  schemaVersion: record.schemaVersion,
  version: record.version,
});
export function createLake(
  database: Database,
  directory: string,
  lease: Lease
) {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS lake_records (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, principal TEXT NOT NULL, artifactId TEXT NOT NULL, version INTEGER NOT NULL,
      schemaId TEXT NOT NULL, schemaVersion INTEGER NOT NULL, publicationKey TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL, metadataJson TEXT NOT NULL, fieldsJson TEXT NOT NULL,
      UNIQUE(artifactId, version)
    );
    CREATE INDEX IF NOT EXISTS lake_schema ON lake_records(principal, schemaId, schemaVersion, sequence);
    CREATE TABLE IF NOT EXISTS lake_schemas (schemaId TEXT NOT NULL, version INTEGER NOT NULL, fieldsJson TEXT NOT NULL, PRIMARY KEY(schemaId,version));
    CREATE TABLE IF NOT EXISTS lake_secret (id INTEGER PRIMARY KEY CHECK(id = 1), secret TEXT NOT NULL);
  `);
  initializeRetention(database);
  initializeQueryIndexes(database);
  initializeReadProtection(database);
  initializeBinaryStorage(database, directory);
  database
    .query("INSERT OR IGNORE INTO lake_secret VALUES (1, ?)")
    .run(crypto.randomUUID());
  const { secret } = Schema.decodeUnknownSync(
    Schema.Struct({ secret: Schema.String })
  )(database.query("SELECT secret FROM lake_secret WHERE id = 1").get());
  const perform = <A>(body: () => A) =>
    Effect.try({
      catch: (cause) => storageError(cause, "Lake storage operation failed"),
      try: () => {
        lease.assertActive();
        return body();
      },
    });
  const pages = createPagination(secret);
  const binaryGroups = binaryPool();
  const get = (artifactId: string, version: number, principal: string) => {
    const raw = database
      .query(
        "SELECT * FROM lake_records WHERE artifactId = ? AND version = ? AND principal = ?"
      )
      .get(artifactId, version, principal);
    if (!raw) {
      throw fail("NotFound", "Artifact version was not found");
    }
    if (
      Schema.decodeUnknownSync(
        Schema.Struct({ reclaimedAt: Schema.NullOr(Schema.String) })
      )(raw).reclaimedAt !== null
    ) {
      throw fail(
        "NotFound",
        "Artifact version was reclaimed; use lake versions --include-reclaimed to inspect its history"
      );
    }
    return metadata(raw).record;
  };
  const commit = (
    identity: Task.Identity,
    output: string,
    artifact: Artifact.Any,
    options: Parameters<Task.RuntimeContext["publish"]>[3],
    digest: string,
    size: number,
    projected: Record<string, Schema.Json>,
    fingerprint: string,
    resolveInstallation: () => void = () => {
      /* JSON has no install intent. */
    }
  ) => {
    const publicationKey = canonical([
      identity.runId,
      identity.invocationPath,
      output,
      options.key,
    ]);
    return database.transaction(() => {
      lease.assertActive();
      const admitted = database
        .query(
          "SELECT owner, entries FROM host_attempts WHERE runId = ? AND nodeId = ? AND activityAttempt = ?"
        )
        .get(identity.runId, identity.invocationPath, identity.attempt);
      const owner =
        admitted &&
        Schema.decodeUnknownSync(Schema.Struct({ owner: Schema.String }))(
          admitted
        ).owner;
      const run = Schema.decodeUnknownSync(
        Schema.Struct({
          lastSequence: Schema.Int,
          principal: Schema.String,
          status: Schema.String,
        })
      )(
        database
          .query(
            "SELECT status, lastSequence, principal FROM host_runs WHERE runId = ?"
          )
          .get(identity.runId)
      );
      if (
        database
          .query("SELECT runId FROM host_fences WHERE runId = ?")
          .get(identity.runId) ||
        owner !== lease.token ||
        ![
          "Queued",
          "Running",
          "Waiting",
          "Retrying",
          "NeedsAttention",
        ].includes(run.status) ||
        (attemptEntry(identity) !== undefined &&
          Schema.decodeUnknownSync(Schema.Struct({ entries: Schema.Int }))(
            admitted
          ).entries !== attemptEntry(identity))
      ) {
        throw fail("Conflict", "Publication attempt is no longer admitted");
      }
      const prior = database
        .query("SELECT * FROM lake_records WHERE publicationKey = ?")
        .get(publicationKey);
      if (prior) {
        if (
          Schema.decodeUnknownSync(
            Schema.Struct({ reclaimedAt: Schema.NullOr(Schema.String) })
          )(prior).reclaimedAt !== null
        ) {
          throw fail("Conflict", "Publication was reclaimed");
        }
        const previous = Schema.decodeUnknownSync(
          Schema.Struct({ fingerprint: Schema.String })
        )(prior);
        if (previous.fingerprint !== fingerprint) {
          throw fail(
            "Conflict",
            "Publication key was reused with different content or metadata"
          );
        }
        resolveInstallation();
        return metadata(prior).record;
      }
      const fieldsJson = canonical(
        (artifact.kind === "bytes" ? [] : artifact.queryFields).map(
          ({ path: fieldPath, types }) => ({
            path: fieldPath,
            types,
          })
        )
      );
      const previousSchema = database
        .query(
          "SELECT fieldsJson, kind, contentType FROM lake_schemas WHERE schemaId = ? AND version = ?"
        )
        .get(artifact.id, artifact.version);
      if (previousSchema) {
        const descriptor = Schema.decodeUnknownSync(
          Schema.Struct({
            contentType: Schema.String,
            fieldsJson: Schema.String,
            kind: Schema.String,
          })
        )(previousSchema);
        if (
          descriptor.fieldsJson !== fieldsJson ||
          descriptor.kind !== artifact.kind ||
          descriptor.contentType !== artifact.contentType
        ) {
          throw fail(
            "Conflict",
            "Artifact kind, content type or query fields changed without a schema version change"
          );
        }
      }
      database
        .query(
          "INSERT OR IGNORE INTO lake_schemas(schemaId,version,fieldsJson,kind,contentType) VALUES (?, ?, ?, ?, ?)"
        )
        .run(
          artifact.id,
          artifact.version,
          fieldsJson,
          artifact.kind,
          artifact.contentType
        );
      const artifactId = sha256(
        canonical([run.principal, identity.taskId, output, options.key])
      );
      const version = countRow.pipe(Schema.decodeUnknownSync)(
        database
          .query(
            "SELECT COALESCE(MAX(version),0) + 1 AS value FROM lake_records WHERE artifactId = ?"
          )
          .get(artifactId)
      ).value;
      checkJsonBudget(projected, jsonLimits);
      const committedAtMillis = Date.now();
      const inserted = database
        .query(
          "INSERT INTO lake_records(principal,artifactId,version,schemaId,schemaVersion,publicationKey,fingerprint,metadataJson,fieldsJson,retentionJson,committedAtMillis) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)"
        )
        .run(
          run.principal,
          artifactId,
          version,
          artifact.id,
          artifact.version,
          publicationKey,
          fingerprint,
          canonical(projected),
          artifact.retention === undefined
            ? null
            : canonical(artifact.retention),
          committedAtMillis
        );
      const record: ArtifactRecord = {
        ...identity,
        artifactId,
        bytes: size,
        committedAt: new Date(committedAtMillis).toISOString(),
        contentType: artifact.contentType,
        digest,
        kind: artifact.kind,
        output,
        schemaId: artifact.id,
        schemaVersion: artifact.version,
        sequence: Number(inserted.lastInsertRowid),
        tags: options.tags ?? {},
        version,
      };
      const normalized = Schema.decodeUnknownSync(ArtifactRecord)(record);
      database
        .query("UPDATE lake_records SET metadataJson = ? WHERE sequence = ?")
        .run(canonical(normalized), normalized.sequence);
      const sequence = run.lastSequence + 1;
      database
        .query(
          "INSERT INTO host_events VALUES (?, ?, ?, ?, 'ArtifactPublished', ?)"
        )
        .run(
          identity.runId,
          sequence,
          `publication/${publicationKey}`,
          normalized.committedAt,
          canonical(normalized)
        );
      database
        .query("UPDATE host_runs SET lastSequence = ? WHERE runId = ?")
        .run(sequence, identity.runId);
      resolveInstallation();
      return normalized;
    })();
  };
  const binary = createBinaryStorage(database, directory, lease);
  return {
    ...createReclamation(database, directory, lease),
    ...createAutomaticRetention(database, directory, lease),
    cleanupReadPins: perform(() => cleanupReadPins(database)),
    download: (artifactId: string, version: number, principal = "owner") =>
      binaryDownload(directory, () => {
        lease.assertActive();
        return get(artifactId, version, principal);
      }),
    get: (artifactId: string, version: number, principal = "owner") =>
      perform(() => {
        const record = get(artifactId, version, principal);
        if (record.kind === "bytes") {
          throw fail(
            "InvalidInput",
            `Binary artifact: use effectory lake download ${artifactId} --version ${version} --output <path>; requires an upgraded CLI supporting lake.bytes.v1`
          );
        }
        const bytes = readFileSync(path.join(directory, record.digest));
        if (bytes.length !== record.bytes || sha256(bytes) !== record.digest) {
          throw fail(
            "ContentUnavailable",
            "Artifact digest or length does not match"
          );
        }
        return Schema.decodeUnknownSync(Content)({
          metadata: record,
          value: parseJson(bytes.toString()),
        });
      }),
    publish: (
      identity: Task.Identity,
      output: string,
      artifact: Artifact.Artifact,
      value: Schema.Json,
      options: Parameters<Task.RuntimeContext["publish"]>[3]
    ) =>
      perform(() => {
        checkJsonBudget(value);
        decode(artifact.schema, value);
        const bytes = canonical(value);
        if (
          Buffer.byteLength(bytes) > maximumBytes ||
          Buffer.byteLength(canonical(options.tags ?? {})) > 8192
        ) {
          throw fail(
            "LimitExceeded",
            "Artifact value or tags exceed the publication limit"
          );
        }
        const digest = sha256(bytes);
        const publicationKey = canonical([
          identity.runId,
          identity.invocationPath,
          output,
          options.key,
        ]);
        const fingerprint = canonical({
          digest,
          schemaId: artifact.id,
          schemaVersion: artifact.version,
          tags: options.tags ?? {},
        });
        const existing = database
          .query(
            "SELECT reclaimedAt FROM lake_records WHERE publicationKey = ?"
          )
          .get(publicationKey);
        if (
          existing &&
          Schema.decodeUnknownSync(
            Schema.Struct({ reclaimedAt: Schema.NullOr(Schema.String) })
          )(existing).reclaimedAt !== null
        ) {
          throw fail("Conflict", "Publication was reclaimed");
        }
        // Flush immutable bytes before committing metadata. An orphan after a crash is harmless.
        atomicBlob(directory, digest, bytes);
        return commit(
          identity,
          output,
          artifact,
          options,
          digest,
          Buffer.byteLength(bytes),
          projectedFields(artifact, value),
          fingerprint
        );
      }).pipe(
        Effect.map((record): Artifact.Reference => ({
          artifactId: record.artifactId,
          digest: record.digest,
          schemaId: record.schemaId,
          schemaVersion: record.schemaVersion,
          version: record.version,
        })),
        Effect.mapError(
          (failure) =>
            new TaskRuntimeError({
              code:
                failure.code === "Conflict"
                  ? "PublicationConflict"
                  : failure.code,
              message: failure.message,
            })
        )
      ),
    publishBytes: <E, R>(
      identity: Task.Identity,
      output: string,
      artifact: Artifact.Bytes,
      source: Stream.Stream<Uint8Array, E, R>,
      options: Parameters<Task.RuntimeContext["publish"]>[3],
      active: () => boolean = () => true
    ) =>
      binary.publish(source, (digest, size, resolveInstallation) => {
        if (!active()) {
          throw fail("InvalidInput", "Invocation closed");
        }
        if (Buffer.byteLength(canonical(options.tags ?? {})) > 8192) {
          throw fail(
            "LimitExceeded",
            "Artifact tags exceed the publication limit"
          );
        }
        const fingerprint = canonical({
          contentType: artifact.contentType,
          digest,
          kind: "bytes",
          schemaId: artifact.id,
          schemaVersion: artifact.version,
          tags: options.tags ?? {},
        });
        return reference(
          commit(
            identity,
            output,
            artifact,
            options,
            digest,
            size,
            {},
            fingerprint,
            resolveInstallation
          )
        );
      }),
    query: (request: Query, principal: string, cursor?: string) =>
      perform(() =>
        database.transaction(() =>
          (() => {
            const page = lakeQuery(database, pages, request, principal, cursor);
            return { ...page, rows: page.rows.map(normalizeRecord) };
          })()
        )()
      ),
    reader: (identity: Task.Identity, active: () => boolean) =>
      createReader(
        database,
        directory,
        lease,
        pages,
        binaryGroups,
        identity,
        active
      ),
    recoverBinary: binary.recover,
    versions: (request: typeof VersionListRequest.Type, principal: string) =>
      perform(() =>
        database.transaction(() =>
          (() => {
            const page = lakeVersions(database, pages, request, principal);
            return {
              ...page,
              items: page.items.map((item) => ({
                ...item,
                ...normalizeRecord(item),
              })),
            };
          })()
        )()
      ),
  };
}

export const Lake =
  Context.Service<ReturnType<typeof createLake>>("effectory/Lake");
export function lakeLayer(filename: string, directory: string) {
  return Layer.effect(
    Lake,
    Effect.gen(function* () {
      yield* HostStore;
      const lease = yield* RepositoryLease;
      const database = yield* Effect.acquireRelease(
        Effect.sync(() => new Database(filename)),
        (db) => Effect.sync(() => db.close())
      );
      const lake = createLake(database, directory, lease);
      yield* lake.recoverBinary;
      yield* resumeReclamation(database, directory, lease).pipe(
        Effect.catch((error) => Effect.logWarning(error.message))
      );
      return lake;
    })
  );
}

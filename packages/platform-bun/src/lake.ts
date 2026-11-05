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

import type { Artifact, Task } from "@effectory/core";
import { TaskRuntimeError } from "@effectory/core";
import {
  canonical,
  decode,
  checkJsonBudget,
  jsonLimits,
} from "@effectory/core/internal/boundary";
import {
  Content,
  Record as ArtifactRecord,
} from "@effectory/runtime/lake-protocol";
import type {
  Query,
  VersionListRequest,
} from "@effectory/runtime/lake-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Context, Effect, Layer, Schema } from "effect";

import { HostStore } from "./host-store.ts";
import { lakeQuery } from "./lake-query.ts";
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

const metadata = (raw: unknown) => {
  const stored = Schema.decodeUnknownSync(Stored)(raw);
  return {
    fields: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      JSON.parse(stored.fieldsJson)
    ),
    record: Schema.decodeUnknownSync(ArtifactRecord)(
      JSON.parse(stored.metadataJson)
    ),
  };
};

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
  const get = (artifactId: string, version: number, principal: string) => {
    const raw = database
      .query(
        "SELECT * FROM lake_records WHERE artifactId = ? AND version = ? AND principal = ?"
      )
      .get(artifactId, version, principal);
    if (!raw) {
      throw fail("NotFound", "Artifact version was not found");
    }
    return metadata(raw).record;
  };
  return {
    get: (artifactId: string, version: number, principal = "owner") =>
      perform(() => {
        const record = get(artifactId, version, principal);
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
      options: Task.PublicationOptions
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
        // Flush immutable bytes before committing metadata. An orphan after a crash is harmless.
        atomicBlob(directory, digest, bytes);
        return database.transaction(() => {
          lease.assertActive();
          const admitted = database
            .query(
              "SELECT owner FROM host_attempts WHERE runId = ? AND nodeId = ? AND activityAttempt = ?"
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
            !["Queued", "Running", "Waiting", "Retrying"].includes(run.status)
          ) {
            throw fail("Conflict", "Publication attempt is no longer admitted");
          }
          const prior = database
            .query("SELECT * FROM lake_records WHERE publicationKey = ?")
            .get(publicationKey);
          if (prior) {
            const previous = Schema.decodeUnknownSync(
              Schema.Struct({ fingerprint: Schema.String })
            )(prior);
            if (previous.fingerprint !== fingerprint) {
              throw fail(
                "Conflict",
                "Publication key was reused with different content or metadata"
              );
            }
            return metadata(prior).record;
          }
          const fieldsJson = canonical(
            artifact.queryFields.map(({ path: fieldPath, types }) => ({
              path: fieldPath,
              types,
            }))
          );
          const previousSchema = database
            .query(
              "SELECT fieldsJson FROM lake_schemas WHERE schemaId = ? AND version = ?"
            )
            .get(artifact.id, artifact.version);
          if (
            previousSchema &&
            Schema.decodeUnknownSync(
              Schema.Struct({ fieldsJson: Schema.String })
            )(previousSchema).fieldsJson !== fieldsJson
          ) {
            throw fail(
              "Conflict",
              "Artifact query fields changed without a schema version change"
            );
          }
          database
            .query("INSERT OR IGNORE INTO lake_schemas VALUES (?, ?, ?)")
            .run(artifact.id, artifact.version, fieldsJson);
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
          const projected = projectedFields(artifact, value);
          checkJsonBudget(projected, jsonLimits);
          const inserted = database
            .query(
              "INSERT INTO lake_records(principal,artifactId,version,schemaId,schemaVersion,publicationKey,fingerprint,metadataJson,fieldsJson) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)"
            )
            .run(
              run.principal,
              artifactId,
              version,
              artifact.id,
              artifact.version,
              publicationKey,
              fingerprint,
              canonical(projected)
            );
          const record: ArtifactRecord = {
            ...identity,
            artifactId,
            bytes: Buffer.byteLength(bytes),
            committedAt: new Date().toISOString(),
            digest,
            output,
            schemaId: artifact.id,
            schemaVersion: artifact.version,
            sequence: Number(inserted.lastInsertRowid),
            tags: options.tags ?? {},
            version,
          };
          const normalized = Schema.decodeUnknownSync(ArtifactRecord)(record);
          database
            .query(
              "UPDATE lake_records SET metadataJson = ? WHERE sequence = ?"
            )
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
          return normalized;
        })();
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
    query: (request: Query, principal: string, cursor?: string) =>
      perform(() =>
        database.transaction(() =>
          lakeQuery(database, pages, request, principal, cursor)
        )()
      ),
    versions: (request: typeof VersionListRequest.Type, principal: string) =>
      perform(() =>
        database.transaction(() =>
          lakeVersions(database, pages, request, principal)
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
      return createLake(database, directory, lease);
    })
  );
}

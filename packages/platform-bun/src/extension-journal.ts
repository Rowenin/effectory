import type { Database } from "bun:sqlite";
import path from "node:path";

import {
  Digest,
  ExtensionChange,
  ExtensionLock,
  ExtensionOperation,
  ResolutionSnapshot,
  extensionLimits,
} from "@effectory/runtime/extension-protocol";
import type { OperationListRequest } from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { canonical, encode } from "@offtree/effectory-sdk/internal/boundary";
import { Schema } from "effect";

import {
  assertWritableBindings,
  lockFilename,
  readLock,
  replaceFile,
  writeBindings,
} from "./extension-bindings.ts";
import { lockRevision, validateLock } from "./extension-cache.ts";
import { operationHistory } from "./operation-history.ts";
import type { Lease } from "./ownership.ts";
import type { createPagination } from "./pagination.ts";
import { encodeStoredLock } from "./runtime-storage-format.ts";

const Row = Schema.Struct({
  candidateJson: Schema.NullOr(Schema.String),
  requestJson: Schema.String,
  resolutionsJson: Schema.String,
  snapshotJson: Schema.String,
});
const RegistryRow = Schema.Struct({
  lockJson: Schema.String,
  revision: Digest,
});
const Intent = Schema.Struct({
  afterJson: Schema.String,
  applicationRevision: Digest,
  beforeJson: Schema.String,
  operationId: Schema.String,
});
const error = (code: OperationError["code"], message: string) =>
  new OperationError({ code, message });
const conflict = () =>
  error(
    "Conflict",
    "Installed extension registry changed; inspect current revisions and submit a new request key"
  );
const decode = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  json: string
) =>
  Schema.decodeUnknownSync(schema)(JSON.parse(json), {
    onExcessProperty: "error",
  });
const lockJson = (lock: typeof ExtensionLock.Type) => {
  const json = canonical(encode(ExtensionLock, validateLock(lock)));
  if (Buffer.byteLength(json) > extensionLimits.lockBytes) {
    throw error("LimitExceeded", "Extension lock exceeds 4 MiB");
  }
  return json;
};

/** Administrative records only. Execution outcomes remain owned by the workflow engine. */
export function createExtensionJournal(
  database: Database,
  repository: string,
  lease: Lease
) {
  lease.assertActive();
  database.run(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS extension_registry (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision TEXT NOT NULL, lockJson TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS extension_operations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, operationId TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, requestKey TEXT NOT NULL,
      fingerprint TEXT NOT NULL, status TEXT NOT NULL, snapshotJson TEXT NOT NULL, requestJson TEXT NOT NULL,
      resolutionsJson TEXT NOT NULL DEFAULT '{}', candidateJson TEXT, UNIQUE(actor, requestKey)
    );
    CREATE TABLE IF NOT EXISTS extension_activation (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), operationId TEXT NOT NULL,
      beforeJson TEXT NOT NULL, afterJson TEXT NOT NULL, applicationRevision TEXT NOT NULL
    );
  `);
  const transaction = <A>(body: () => A): A => {
    lease.assertActive();
    return database.transaction(body)();
  };
  const registry = () => {
    lease.assertActive();
    const row = database
      .query(
        "SELECT revision, lockJson FROM extension_registry WHERE singleton = 1"
      )
      .get();
    if (row === null) {
      throw error("Unavailable", "Extension registry has not been reconciled");
    }
    const value = Schema.decodeUnknownSync(RegistryRow)(row);
    const lock = validateLock(JSON.parse(value.lockJson));
    if (lockRevision(lock) !== value.revision) {
      throw error("Unavailable", "Extension registry is inconsistent");
    }
    return { lock, revision: value.revision };
  };
  const setRegistry = (lock: typeof ExtensionLock.Type) =>
    database
      .query(
        "INSERT INTO extension_registry(singleton, revision, lockJson) VALUES(1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision, lockJson = excluded.lockJson"
      )
      .run(lockRevision(lock), lockJson(lock));
  const read = (id: string, actor: string) => {
    lease.assertActive();
    const raw = database
      .query(
        "SELECT snapshotJson, requestJson, resolutionsJson, candidateJson FROM extension_operations WHERE operationId = ? AND actor = ?"
      )
      .get(id, actor);
    if (raw === null) {
      throw error("NotFound", "Extension operation was not found");
    }
    const row = Schema.decodeUnknownSync(Row)(raw);
    return {
      candidate:
        row.candidateJson === null
          ? null
          : validateLock(JSON.parse(row.candidateJson)),
      request: decode(ExtensionChange, row.requestJson),
      resolutions: decode(ResolutionSnapshot, row.resolutionsJson),
      snapshot: decode(ExtensionOperation, row.snapshotJson),
    };
  };
  const save = (snapshot: typeof ExtensionOperation.Type) =>
    database
      .query(
        "UPDATE extension_operations SET status = ?, snapshotJson = ? WHERE operationId = ? AND actor = ?"
      )
      .run(
        snapshot.status,
        JSON.stringify(snapshot),
        snapshot.operationId,
        snapshot.actor
      );
  const intent = () => {
    lease.assertActive();
    const value = database
      .query(
        "SELECT operationId, beforeJson, afterJson, applicationRevision FROM extension_activation WHERE singleton = 1"
      )
      .get();
    return value === null ? null : Schema.decodeUnknownSync(Intent)(value);
  };
  const publish = (
    boundary?: (name: "lock" | "bindings" | "pointer") => void
  ) => {
    const pending = intent();
    if (!pending) {
      throw error("Unavailable", "No extension activation intent exists");
    }
    const before = validateLock(JSON.parse(pending.beforeJson));
    const after = validateLock(JSON.parse(pending.afterJson));
    const current = lockRevision(readLock(repository));
    if (current !== lockRevision(before) && current !== lockRevision(after)) {
      throw conflict();
    }
    replaceFile(
      lockFilename(repository),
      encodeStoredLock(repository, pending.afterJson)
    );
    boundary?.("lock");
    writeBindings(repository, after);
    boundary?.("bindings");
    replaceFile(
      path.join(repository, ".effectory", "active.json"),
      JSON.stringify({ revision: pending.applicationRevision })
    );
    boundary?.("pointer");
  };
  const finish = () =>
    transaction(() => {
      const pending = intent();
      if (!pending) {
        throw error("Unavailable", "No extension activation intent exists");
      }
      const after = validateLock(JSON.parse(pending.afterJson));
      const row = database
        .query(
          "SELECT snapshotJson FROM extension_operations WHERE operationId = ?"
        )
        .get(pending.operationId);
      const snapshot = decode(
        ExtensionOperation,
        Schema.decodeUnknownSync(
          Schema.Struct({ snapshotJson: Schema.String })
        )(row).snapshotJson
      );
      setRegistry(after);
      save({
        ...snapshot,
        error: null,
        result: {
          applicationRevision: pending.applicationRevision,
          installedRevision: lockRevision(after),
        },
        status: "Succeeded",
        updatedAt: new Date().toISOString(),
      });
      database
        .query("DELETE FROM extension_activation WHERE singleton = 1")
        .run();
    });
  return {
    accept: (
      value: typeof ExtensionChange.Type,
      actor: string,
      applicationRevision: string,
      accepting = true
    ) =>
      transaction(() => {
        const request = Schema.decodeSync(ExtensionChange)(value, {
          onExcessProperty: "error",
        });
        const fingerprint = canonical(encode(ExtensionChange, request));
        const previous = database
          .query(
            "SELECT operationId, fingerprint FROM extension_operations WHERE actor = ? AND requestKey = ?"
          )
          .get(actor, request.requestKey);
        if (previous !== null) {
          const receipt = Schema.decodeUnknownSync(
            Schema.Struct({
              fingerprint: Schema.String,
              operationId: Schema.String,
            })
          )(previous);
          if (receipt.fingerprint !== fingerprint) {
            throw error(
              "Conflict",
              "Request key was already used with different extension input"
            );
          }
          return read(receipt.operationId, actor).snapshot;
        }
        if (!accepting) {
          throw error("Unavailable", "Daemon is draining");
        }
        const current = registry();
        if (
          intent() ||
          current.revision !== request.expectedRevision ||
          lockRevision(readLock(repository)) !== current.revision
        ) {
          throw conflict();
        }
        const counts = Schema.decodeUnknownSync(
          Schema.Struct({ pending: Schema.Int, total: Schema.Int })
        )(
          database
            .query(
              "SELECT COUNT(*) AS total, COALESCE(SUM(status IN ('Queued', 'Running')), 0) AS pending FROM extension_operations"
            )
            .get()
        );
        if (counts.total >= 10_000 || counts.pending >= 32) {
          throw error(
            "LimitExceeded",
            "Extension operations support 32 pending and 10000 retained records"
          );
        }
        const now = new Date().toISOString();
        const snapshot: typeof ExtensionOperation.Type = {
          acceptedAt: now,
          actor,
          baseApplicationRevision: applicationRevision,
          error: null,
          expectedRevision: request.expectedRevision,
          kind: request.kind,
          operationId: crypto.randomUUID(),
          requestKey: request.requestKey,
          result: null,
          sequence: counts.total + 1,
          status: "Queued",
          updatedAt: now,
        };
        Schema.decodeSync(ExtensionOperation)(snapshot);
        // No operation deletion in v0, so total + 1 is the durable sequence.
        database
          .query(
            "INSERT INTO extension_operations(sequence, operationId, actor, requestKey, fingerprint, status, snapshotJson, requestJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            snapshot.sequence,
            snapshot.operationId,
            actor,
            request.requestKey,
            fingerprint,
            snapshot.status,
            JSON.stringify(snapshot),
            JSON.stringify(request)
          );
        return snapshot;
      }),
    begin: (id: string, actor: string, applicationRevision: string) =>
      transaction(() => {
        const operation = read(id, actor);
        const current = registry();
        if (
          !operation.candidate ||
          operation.snapshot.status !== "Running" ||
          intent()
        ) {
          throw error("Conflict", "Extension candidate cannot be activated");
        }
        if (
          current.revision !== operation.snapshot.expectedRevision ||
          lockRevision(readLock(repository)) !== current.revision
        ) {
          throw conflict();
        }
        assertWritableBindings(repository);
        Schema.decodeSync(Digest)(applicationRevision);
        database
          .query(
            "INSERT INTO extension_activation(singleton, operationId, beforeJson, afterJson, applicationRevision) VALUES(1, ?, ?, ?, ?)"
          )
          .run(
            id,
            lockJson(current.lock),
            lockJson(operation.candidate),
            applicationRevision
          );
      }),
    candidate: (id: string, actor: string, lock: typeof ExtensionLock.Type) =>
      transaction(() => {
        if (read(id, actor).snapshot.status !== "Running") {
          throw error("Conflict", "Extension operation is not running");
        }
        database
          .query(
            "UPDATE extension_operations SET candidateJson = ? WHERE operationId = ?"
          )
          .run(lockJson(lock), id);
      }),
    checkpoint: (
      id: string,
      actor: string,
      resolutions: typeof ResolutionSnapshot.Type
    ) =>
      transaction(() => {
        const operation = read(id, actor);
        if (operation.snapshot.status !== "Running") {
          throw error("Conflict", "Extension operation is not running");
        }
        if (
          Object.keys(resolutions).length > 128 ||
          Buffer.byteLength(JSON.stringify(resolutions)) > 262_144
        ) {
          throw error(
            "LimitExceeded",
            "Extension resolution checkpoint exceeds its limit"
          );
        }
        database
          .query(
            "UPDATE extension_operations SET resolutionsJson = ? WHERE operationId = ?"
          )
          .run(
            JSON.stringify(Schema.decodeSync(ResolutionSnapshot)(resolutions)),
            id
          );
      }),
    fail: (id: string, actor: string, failure: OperationError) =>
      transaction(() => {
        if (intent()?.operationId === id) {
          throw error(
            "Unavailable",
            "Activation is committed and must be recovered before continuing"
          );
        }
        const operation = read(id, actor);
        save({
          ...operation.snapshot,
          error: failure,
          status: "Failed",
          updatedAt: new Date().toISOString(),
        });
      }),
    finish,
    get: (id: string, actor: string) => read(id, actor).snapshot,
    intent,
    list: (actor: string, after = 0, limit = 100) => {
      lease.assertActive();
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 200
      ) {
        throw error(
          "InvalidInput",
          "Operation page requires a nonnegative sequence and a limit between 1 and 200"
        );
      }
      return database
        .query(
          "SELECT snapshotJson FROM extension_operations WHERE actor = ? AND sequence > ? ORDER BY sequence LIMIT ?"
        )
        .all(actor, after, limit)
        .map((row) =>
          decode(
            ExtensionOperation,
            Schema.decodeUnknownSync(
              Schema.Struct({ snapshotJson: Schema.String })
            )(row).snapshotJson
          )
        );
    },
    next: () => {
      lease.assertActive();
      const row = database
        .query(
          "SELECT operationId, actor FROM extension_operations WHERE status IN ('Queued', 'Running') ORDER BY sequence LIMIT 1"
        )
        .get();
      if (row === null) {
        return null;
      }
      const selected = Schema.decodeUnknownSync(
        Schema.Struct({ actor: Schema.String, operationId: Schema.String })
      )(row);
      return read(selected.operationId, selected.actor);
    },
    page: (
      request: typeof OperationListRequest.Type,
      actor: string,
      pages: ReturnType<typeof createPagination>
    ) => transaction(() => operationHistory(database, pages, request, actor)),
    publish,
    read,
    /** Run before application loading/listener startup; a durable intent always rolls forward. */
    recover: () => {
      lease.assertActive();
      if (intent()) {
        publish();
        finish();
      }
      // A checked-out lock may change while the daemon is stopped. Pending operations
      // keep their original expected revision and will fail rather than overwrite it.
      setRegistry(readLock(repository));
    },
    registry,
    start: (id: string, actor: string) =>
      transaction(() => {
        const operation = read(id, actor);
        if (!["Queued", "Running"].includes(operation.snapshot.status)) {
          throw error("Conflict", "Extension operation has already settled");
        }
        save({
          ...operation.snapshot,
          status: "Running",
          updatedAt: new Date().toISOString(),
        });
      }),
  };
}

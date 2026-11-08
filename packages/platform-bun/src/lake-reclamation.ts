/* oxlint-disable no-redeclare, no-loop-func -- Schemas share decoded names; loop Effects are yielded sequentially before loop state advances. */
import type { Database } from "bun:sqlite";
import { closeSync, fsyncSync, lstatSync, openSync, unlinkSync } from "node:fs";
import path from "node:path";

import {
  ReclamationApply,
  ReclamationRequest,
  ReclamationPlan,
  ReclamationReceipt,
} from "@effectory/runtime/lake-protocol";
import {
  OperationError,
  terminal,
  RunStatus,
} from "@effectory/runtime/protocol";
import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import { Cause, Clock, Effect, Exit, Schema } from "effect";

import { versionProtection, isProtected } from "./lake-protection.ts";
import { RetentionPolicy } from "./lake-retention-store.ts";
import type { Lease } from "./ownership.ts";
import { storageError } from "./storage-error.ts";

const Count = Schema.Struct({ value: Schema.Int });
const PolicyRow = Schema.Struct({
  retentionJson: Schema.NullOr(Schema.String),
});
const VersionRow = Schema.Struct({ version: Schema.Int });
const Row = Schema.Struct({
  artifactId: Schema.String,
  bytes: Schema.Int,
  committedAtMillis: Schema.Finite,
  digest: Schema.String,
  newestVersion: Schema.optionalKey(Schema.Int),
  schemaId: Schema.String,
  schemaVersion: Schema.Int,
  sequence: Schema.Int,
  status: Schema.NullOr(RunStatus),
  version: Schema.Int,
});
type Row = typeof Row.Type;
const StoredCandidate = Schema.Struct({
  ...Row.fields,
  reason: Schema.Literals(["Age", "VersionCount", "Explicit"]),
});
type Candidate = typeof StoredCandidate.Type;
const StoredPlan = Schema.Struct({
  candidatesJson: Schema.String,
  createdAt: Schema.Finite,
  expiresAt: Schema.Finite,
  planId: Schema.String,
  principal: Schema.String,
  receiptJson: Schema.NullOr(Schema.String),
  requestJson: Schema.String,
  snapshot: Schema.Int,
  summaryJson: Schema.String,
});
export const ReclamationJob = Schema.Struct({
  bytes: Schema.Int,
  digest: Schema.String,
  id: Schema.Int,
  planId: Schema.String,
  started: Schema.Int,
});
const decodePolicyRow = Schema.decodeUnknownSync(PolicyRow);
const decodeVersionRow = Schema.decodeUnknownSync(VersionRow);
const decodePolicy = Schema.decodeUnknownSync(RetentionPolicy);
const decodeRows = Schema.decodeUnknownSync(Schema.Array(Row));
const fail = (code: OperationError["code"], message: string) =>
  new OperationError({ code, message });
const rowSql = (
  snapshot?: number
) => `SELECT r.sequence, r.artifactId, r.version, r.schemaId, r.schemaVersion, r.committedAtMillis,
  json_extract(r.metadataJson,'$.digest') AS digest, json_extract(r.metadataJson,'$.bytes') AS bytes, COALESCE(h.status,retired.status) status${snapshot === undefined ? "" : `, (SELECT version FROM lake_records newest WHERE newest.artifactId = r.artifactId AND newest.sequence <= ${snapshot} AND newest.reclaimedAt IS NULL ORDER BY newest.version DESC LIMIT 1) AS newestVersion`}
  FROM lake_records r LEFT JOIN host_runs h ON h.runId = json_extract(r.metadataJson,'$.runId') LEFT JOIN host_retired_runs retired ON retired.runId=json_extract(r.metadataJson,'$.runId') AND retired.principal=r.principal AND json_extract(retired.recordJson,'$.status')=retired.status`;

function identity(database: Database, artifactId: string, snapshot: number) {
  const newest = decodePolicyRow(
    database
      .query(
        "SELECT retentionJson FROM lake_records WHERE artifactId = ? AND sequence <= ? ORDER BY version DESC LIMIT 1"
      )
      .get(artifactId, snapshot)
  );
  const policy =
    newest.retentionJson === null
      ? {}
      : decodePolicy(JSON.parse(newest.retentionJson));
  const versions = new Map<number, number | null>();
  const threshold = (count: number) => {
    if (versions.has(count)) {
      return versions.get(count) ?? null;
    }
    const row = database
      .query(
        "SELECT version FROM lake_records WHERE artifactId = ? AND sequence <= ? AND reclaimedAt IS NULL ORDER BY version DESC LIMIT 1 OFFSET ?"
      )
      .get(artifactId, snapshot, count - 1);
    const value = row === null ? null : decodeVersionRow(row).version;
    versions.set(count, value);
    return value;
  };
  return { policy, threshold };
}

function reason(
  row: Row,
  request: ReclamationRequest,
  now: number,
  getInfo: () => ReturnType<typeof identity>
): Candidate["reason"] | null {
  const age = Math.max(0, now - row.committedAtMillis);
  if (request._tag === "Version") {
    return "Explicit";
  }
  if (request._tag === "Selection") {
    if (
      request.olderThanMillis !== undefined &&
      age <= request.olderThanMillis
    ) {
      return null;
    }
    if (request.keepLatest !== undefined) {
      const kept = getInfo().threshold(request.keepLatest);
      if (kept === null || row.version >= kept) {
        return null;
      }
    }
    return request.olderThanMillis === undefined ? "VersionCount" : "Age";
  }
  const info = getInfo();
  if (
    info.policy.maxAgeMillis === undefined &&
    info.policy.maxVersions === undefined
  ) {
    return null;
  }
  const newest = row.newestVersion ?? info.threshold(1);
  if (row.version === newest) {
    return null;
  }
  if (
    info.policy.maxAgeMillis !== undefined &&
    age > info.policy.maxAgeMillis
  ) {
    return "Age";
  }
  if (
    info.policy.maxVersions !== undefined &&
    (newest === null || info.policy.maxVersions < newest)
  ) {
    const kept = info.threshold(info.policy.maxVersions);
    if (kept !== null && row.version < kept) {
      return "VersionCount";
    }
  }
  return null;
}

function selection(request: ReclamationRequest) {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (request._tag === "Version") {
    clauses.push("r.artifactId = ?", "r.version = ?");
    args.push(request.artifactId, request.version);
  } else {
    if (request.schemaId !== undefined) {
      clauses.push("r.schemaId = ?");
      args.push(request.schemaId);
    }
    if (request.schemaVersion !== undefined) {
      clauses.push("r.schemaVersion = ?");
      args.push(request.schemaVersion);
    }
    if (request._tag === "Selection" && request.artifactId !== undefined) {
      clauses.push("r.artifactId = ?");
      args.push(request.artifactId);
    }
  }
  return { args, clause: clauses.length ? `AND ${clauses.join(" AND ")}` : "" };
}

function retainedReferences(database: Database, digest: string, limit = 1) {
  return Count.pipe(Schema.decodeUnknownSync)(
    database
      .query(
        "SELECT COUNT(*) AS value FROM (SELECT 1 FROM lake_records WHERE reclaimedAt IS NULL AND json_extract(metadataJson,'$.digest') = ? LIMIT ?)"
      )
      .get(digest, limit)
  ).value;
}
const unreadableRecoveryIntents = (error: unknown) =>
  storageError(error, "Could not read reclamation recovery intents");
export function reclamationReceipt(
  database: Database,
  planId: string
): ReclamationReceipt {
  const row = Schema.decodeUnknownSync(
    Schema.Struct({ receiptJson: Schema.String })
  )(
    database
      .query("SELECT receiptJson FROM lake_reclamation_plans WHERE planId = ?")
      .get(planId)
  );
  const result = Schema.decodeUnknownSync(ReclamationReceipt)(
    JSON.parse(row.receiptJson)
  );
  const pendingBytes = Count.pipe(Schema.decodeUnknownSync)(
    database
      .query(
        "SELECT COALESCE(SUM(bytes),0) AS value FROM lake_reclamation_unlinks WHERE planId = ? AND state = 'Pending'"
      )
      .get(planId)
  ).value;
  return { ...result, pendingBytes };
}
function finishJob(
  database: Database,
  job: typeof ReclamationJob.Type,
  state: "Done" | "Shared" | "Missing"
) {
  database.transaction(() => {
    const current = reclamationReceipt(database, job.planId);
    database
      .query(
        "UPDATE lake_reclamation_unlinks SET state = ?, lastError = NULL, failedAt = NULL WHERE id = ? AND state = 'Pending'"
      )
      .run(state, job.id);
    database
      .query(
        "UPDATE lake_reclamation_plans SET receiptJson = ? WHERE planId = ?"
      )
      .run(
        canonical({
          ...current,
          reclaimedBytes:
            current.reclaimedBytes + (state === "Done" ? job.bytes : 0),
        }),
        job.planId
      );
  })();
}

/** Reference check and unlink cannot yield: publication uses the same synchronous store boundary. */
export function unlinkReclamationJob(
  database: Database,
  directory: string,
  job: typeof ReclamationJob.Type
) {
  if (retainedReferences(database, job.digest) > 0) {
    finishJob(database, job, "Shared");
    return;
  }
  if (!/^[a-f0-9]{64}$/u.test(job.digest)) {
    throw fail("Unavailable", "Unsafe reclamation digest");
  }
  const filename = path.join(directory, job.digest);
  try {
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== job.bytes) {
      throw fail(
        "ContentUnavailable",
        "Reclamation target is not the expected regular blob"
      );
    }
    database
      .query("UPDATE lake_reclamation_unlinks SET started = 1 WHERE id = ?")
      .run(job.id);
    unlinkSync(filename);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      Reflect.get(error, "code") === "ENOENT"
    ) {
      if (!job.started) {
        finishJob(database, job, "Missing");
        return;
      }
    } else {
      throw error;
    }
  }
  const folder = openSync(directory, "r");
  try {
    fsyncSync(folder);
  } finally {
    closeSync(folder);
  }
  finishJob(database, job, "Done");
}

export function resumeReclamation(
  database: Database,
  directory: string,
  lease: Lease,
  planId?: string
) {
  return Effect.gen(function* () {
    let after = 0;
    let failure: string | undefined;
    while (true) {
      const rows = yield* Effect.try({
        catch: unreadableRecoveryIntents,
        try: (): unknown => {
          lease.assertActive();
          return database
            .query(
              `SELECT id,planId,digest,bytes,started FROM lake_reclamation_unlinks WHERE state = 'Pending' AND id > ? ${planId !== undefined && planId !== "" ? "AND planId = ?" : ""} ORDER BY id LIMIT 32`
            )
            .all(
              after,
              ...(planId !== undefined && planId !== "" ? [planId] : [])
            );
        },
      });
      const jobs = yield* Schema.decodeUnknownEffect(
        Schema.Array(ReclamationJob)
      )(rows).pipe(Effect.mapError(unreadableRecoveryIntents));
      if (jobs.length === 0) {
        break;
      }
      for (const job of jobs) {
        yield* Effect.try({
          catch: (error) => storageError(error, "Reclamation cleanup failed"),
          try: () => {
            lease.assertActive();
            // Another resumed apply may have finished this job while we yielded.
            const pending = database
              .query(
                "SELECT id,planId,digest,bytes,started FROM lake_reclamation_unlinks WHERE id = ? AND state = 'Pending'"
              )
              .get(job.id);
            if (pending === null) {
              return;
            }
            // A row that no longer decodes is recorded like a failed unlink.
            const decoded = Schema.decodeUnknownExit(ReclamationJob)(pending);
            try {
              if (Exit.isFailure(decoded)) {
                throw Cause.squash(decoded.cause);
              }
              unlinkReclamationJob(database, directory, decoded.value);
            } catch (error) {
              failure = String(error).slice(0, 500);
              database
                .query(
                  "UPDATE lake_reclamation_unlinks SET lastError = ?, failedAt = ? WHERE id = ?"
                )
                .run(failure, Date.now(), job.id);
            }
          },
        });
        after = job.id;
        yield* Effect.yieldNow;
      }
    }
    if (failure !== undefined) {
      const current =
        planId === undefined
          ? undefined
          : yield* Effect.try({
              catch: (error) =>
                storageError(error, "Could not read reclamation receipt"),
              try: () => reclamationReceipt(database, planId),
            });
      const counts = current
        ? ` (${current.deletedVersions} versions deleted, ${current.reclaimedBytes} bytes reclaimed, ${current.pendingBytes} bytes pending)`
        : "";
      return yield* fail(
        "Unavailable",
        `Reclamation cleanup remains pending${planId !== undefined && planId !== "" ? ` for plan ${planId}` : ""}${counts}: ${failure}. Re-run lake reclaim apply with the same plan id.`
      );
    }
  });
}

/** Called only inside the caller's immediate metadata transaction after eligibility checks. */
export function commitReclamation(
  database: Database,
  planId: string,
  principal: string,
  approved: readonly {
    readonly sequence: number;
    readonly digest: string;
    readonly bytes: number;
  }[],
  candidateCount: number,
  now: number,
  origin: "Manual" | "Automatic"
) {
  const at = new Date(now).toISOString();
  for (const row of approved) {
    database
      .query(
        "UPDATE lake_records SET reclaimedAt = ?, reclamationPlanId = ?, fieldsJson = '{}' WHERE sequence = ?"
      )
      .run(at, planId, row.sequence);
  }
  const digests = new Map(approved.map((row) => [row.digest, row.bytes]));
  for (const [digest, bytes] of digests) {
    if (retainedReferences(database, digest) === 0) {
      database
        .query(
          "INSERT OR IGNORE INTO lake_reclamation_unlinks(planId,digest,bytes) VALUES(?,?,?)"
        )
        .run(planId, digest, bytes);
    }
  }
  const result: ReclamationReceipt = {
    deletedVersions: approved.length,
    origin,
    pendingBytes: 0,
    planId,
    reclaimedBytes: 0,
    skippedVersions: candidateCount - approved.length,
  };
  database
    .query("UPDATE lake_reclamation_plans SET receiptJson = ? WHERE planId = ?")
    .run(canonical(result), planId);
  if (approved.length) {
    database
      .query(
        "INSERT INTO lake_reclamation_epochs(principal,epoch) VALUES(?,1) ON CONFLICT(principal) DO UPDATE SET epoch = epoch + 1"
      )
      .run(principal);
  }
}

export function createReclamation(
  database: Database,
  directory: string,
  lease: Lease
) {
  const perform = <A>(body: () => A) =>
    Effect.try({
      catch: (error) => storageError(error, "Lake reclamation failed"),
      try: () => {
        lease.assertActive();
        return body();
      },
    });
  const planReclamation = (value: ReclamationRequest, principal = "owner") =>
    Effect.gen(function* () {
      const request = yield* Schema.decodeEffect(ReclamationRequest)(value, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(() =>
          fail("InvalidInput", "Invalid reclamation selection")
        )
      );
      const now = yield* Clock.currentTimeMillis;
      const snapshot = yield* perform(
        () =>
          Count.pipe(Schema.decodeUnknownSync)(
            database
              .query(
                "SELECT COALESCE(MAX(sequence),0) AS value FROM lake_records WHERE principal = ?"
              )
              .get(principal)
          ).value
      );
      const filter = selection(request);
      const candidates: Candidate[] = [];
      let protectedVersions = 0;
      const protectedBy = {
        consumerVersions: 0,
        producerVersions: 0,
        reportVersions: 0,
      };
      let after = 0;
      let hasMore = false;
      const identities = new Map<string, ReturnType<typeof identity>>();
      while (true) {
        const rows = yield* perform(() =>
          decodeRows(
            database
              .query(
                `${rowSql(request._tag === "Policy" ? snapshot : undefined)} WHERE r.principal = ? AND r.reclaimedAt IS NULL AND r.sequence > ? AND r.sequence <= ? ${filter.clause} ORDER BY r.sequence LIMIT 128`
              )
              .all(principal, after, snapshot, ...filter.args)
          )
        );
        if (rows.length === 0) {
          break;
        }
        yield* perform(() => {
          for (const row of rows) {
            after = row.sequence;
            if (
              request._tag === "Policy" &&
              row.version === row.newestVersion
            ) {
              continue;
            }
            const why = reason(row, request, now, () => {
              let info = identities.get(row.artifactId);
              if (!info) {
                info = identity(database, row.artifactId, snapshot);
                if (identities.size >= 2048) {
                  identities.clear();
                }
                identities.set(row.artifactId, info);
              }
              return info;
            });
            if (why === null) {
              continue;
            }
            const protection = versionProtection(database, row.sequence);
            if (isProtected(protection)) {
              if (protection.producerRunId !== null) {
                protectedBy.producerVersions += 1;
              }
              if (protection.consumerRunCount > 0) {
                protectedBy.consumerVersions += 1;
              }
              if (protection.reportSourceRunId !== null) {
                protectedBy.reportVersions += 1;
              }
              protectedVersions += 1;
              continue;
            }
            if (candidates.length === 1000) {
              hasMore = true;
              break;
            }
            candidates.push({ ...row, reason: why });
          }
        });
        if (hasMore) {
          break;
        }
        yield* Effect.yieldNow;
      }
      return yield* perform(() =>
        database.transaction(() => {
          const planId = crypto.randomUUID();
          database
            .query(
              "UPDATE lake_reclamation_plans SET candidatesJson = '[]', summaryJson = '{}', requestJson = '{}' WHERE receiptJson IS NULL AND expiresAt <= ? AND requestJson <> '{}'"
            )
            .run(now);
          const active = Count.pipe(Schema.decodeUnknownSync)(
            database
              .query(
                "SELECT COUNT(*) AS value FROM lake_reclamation_plans WHERE principal = ? AND receiptJson IS NULL AND expiresAt > ?"
              )
              .get(principal, now)
          ).value;
          if (active >= 64) {
            throw fail(
              "LimitExceeded",
              "64 unapplied reclamation plans already exist; apply a plan or wait for expiry"
            );
          }
          const byIdentity = new Map<string, Candidate[]>();
          const byDigest = new Map<string, Candidate[]>();
          for (const row of candidates) {
            byIdentity.set(row.artifactId, [
              ...(byIdentity.get(row.artifactId) ?? []),
              row,
            ]);
            byDigest.set(row.digest, [
              ...(byDigest.get(row.digest) ?? []),
              row,
            ]);
          }
          const emptied = new Set<string>();
          for (const [id, rows] of byIdentity) {
            const count = Count.pipe(Schema.decodeUnknownSync)(
              database
                .query(
                  "SELECT COUNT(*) AS value FROM lake_records WHERE artifactId = ? AND reclaimedAt IS NULL"
                )
                .get(id)
            ).value;
            if (count > 0 && rows.length === count) {
              emptied.add(id);
            }
          }
          let reclaimableBlobBytes = 0;
          for (const [digest, rows] of byDigest) {
            if (
              retainedReferences(database, digest, rows.length + 1) ===
              rows.length
            ) {
              reclaimableBlobBytes += rows[0]?.bytes ?? 0;
            }
          }
          const result = ReclamationPlan.make({
            candidateVersions: candidates.length,
            candidates: candidates.map((row) => ({
              artifactId: row.artifactId,
              bytes: row.bytes,
              reason: row.reason,
              removesFinalVersion:
                emptied.has(row.artifactId) &&
                row.version ===
                  Math.max(
                    ...(byIdentity.get(row.artifactId) ?? []).map(
                      (item) => item.version
                    )
                  ),
              version: row.version,
            })),
            emptiedArtifacts: emptied.size,
            expiresAt: new Date(now + 900_000).toISOString(),
            hasMore,
            logicalBytes: candidates.reduce((sum, row) => sum + row.bytes, 0),
            planId,
            protectedBy,
            protectedVersions,
            reclaimableBlobBytes,
          });
          database
            .query(
              "INSERT INTO lake_reclamation_plans(planId,principal,createdAt,expiresAt,requestJson,snapshot,candidatesJson,summaryJson) VALUES(?,?,?,?,?,?,?,?)"
            )
            .run(
              planId,
              principal,
              now,
              now + 900_000,
              canonical(request),
              snapshot,
              canonical(candidates),
              canonical(result)
            );
          return result;
        })()
      );
    });

  const applyReclamation = (
    value: { readonly planId: string },
    principal = "owner"
  ) =>
    Effect.gen(function* () {
      const request = yield* Schema.decodeEffect(ReclamationApply)(value, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(() =>
          fail("InvalidInput", "Invalid reclamation plan id")
        )
      );
      const now = yield* Clock.currentTimeMillis;
      yield* perform(() =>
        database
          .transaction(() => {
            const raw = database
              .query(
                "SELECT * FROM lake_reclamation_plans WHERE planId = ? AND principal = ?"
              )
              .get(request.planId, principal);
            if (raw === null) {
              throw fail(
                "NotFound",
                "Reclamation plan was not found for this actor"
              );
            }
            const plan = Schema.decodeUnknownSync(StoredPlan)(raw);
            if (plan.receiptJson !== null) {
              return;
            }
            if (plan.expiresAt <= now) {
              throw fail("Conflict", "Reclamation plan expired; preview again");
            }
            const selectionRequest = Schema.decodeUnknownSync(
              ReclamationRequest
            )(JSON.parse(plan.requestJson));
            const candidates = Schema.decodeUnknownSync(
              Schema.Array(StoredCandidate)
            )(JSON.parse(plan.candidatesJson));
            const approved: Row[] = [];
            const identities = new Map<string, ReturnType<typeof identity>>();
            // Evaluate all candidates against the same current ranking before mutating any row.
            for (const candidate of candidates) {
              const rawRow = database
                .query(
                  `${rowSql()} WHERE r.principal = ? AND r.sequence = ? AND r.reclaimedAt IS NULL`
                )
                .get(principal, candidate.sequence);
              if (rawRow === null) {
                continue;
              }
              const row = Schema.decodeUnknownSync(Row)(rawRow);
              if (
                row.artifactId !== candidate.artifactId ||
                row.version !== candidate.version ||
                row.sequence > plan.snapshot ||
                row.status === null ||
                !terminal.has(row.status) ||
                isProtected(versionProtection(database, row.sequence))
              ) {
                continue;
              }
              let info = identities.get(row.artifactId);
              if (!info) {
                info = identity(
                  database,
                  row.artifactId,
                  Number.MAX_SAFE_INTEGER
                );
                identities.set(row.artifactId, info);
              }
              if (
                reason(row, selectionRequest, plan.createdAt, () => info) !==
                null
              ) {
                approved.push(row);
              }
            }
            commitReclamation(
              database,
              plan.planId,
              principal,
              approved,
              candidates.length,
              now,
              "Manual"
            );
          })
          .immediate()
      );
      yield* resumeReclamation(database, directory, lease, request.planId);
      return yield* perform(() => reclamationReceipt(database, request.planId));
    });
  return { applyReclamation, planReclamation };
}

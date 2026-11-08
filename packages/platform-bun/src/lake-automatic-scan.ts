import type { Database } from "bun:sqlite";

import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import { Schema } from "effect";

import { automaticState } from "./lake-automatic-store.ts";
import { versionIsProtected } from "./lake-protection.ts";
import { commitReclamation } from "./lake-reclamation.ts";
import { RetentionPolicy } from "./lake-retention-store.ts";

const Identity = Schema.Struct({
  artifactId: Schema.String,
  epoch: Schema.Int,
  sequence: Schema.Int,
});
const Checkpoint = Schema.Struct({
  after: Schema.Int,
  before: Schema.Int,
  current: Schema.NullOr(Identity),
  cutoff: Schema.Finite,
  horizon: Schema.Int,
  rank: Schema.Int,
  restarts: Schema.Int,
});
const Row = Schema.Struct({
  bytes: Schema.Int,
  committedAtMillis: Schema.Finite,
  digest: Schema.String,
  sequence: Schema.Int,
  version: Schema.Int,
});
const Latest = Schema.Struct({ retentionJson: Schema.NullOr(Schema.String) });
const Count = Schema.Struct({ value: Schema.Int });
const decodeIdentity = Schema.decodeUnknownSync(Identity);

function capturedPolicy(database: Database, artifactId: string) {
  const latest = database
    .query(
      "SELECT retentionJson FROM lake_records WHERE artifactId=? ORDER BY version DESC LIMIT 1"
    )
    .get(artifactId);
  const policyJson = latest
    ? Schema.decodeUnknownSync(Latest)(latest).retentionJson
    : null;
  return policyJson === null
    ? {}
    : Schema.decodeUnknownSync(RetentionPolicy)(JSON.parse(policyJson));
}

function eligible(
  policy: typeof RetentionPolicy.Type,
  row: typeof Row.Type,
  rank: number,
  cutoff: number
) {
  return (
    rank > 1 &&
    ((policy.maxAgeMillis !== undefined &&
      Math.max(0, cutoff - row.committedAtMillis) > policy.maxAgeMillis) ||
      (policy.maxVersions !== undefined && rank > policy.maxVersions))
  );
}

/** One bounded immediate transaction. No Effects, author code, filesystem calls or iterators. */
export function scanAutomaticRetention(
  database: Database,
  generation: number,
  now: number
) {
  const state = automaticState(database);
  if (!state.enabled || state.generation !== generation) {
    return false;
  }
  const cp =
    state.checkpoint === null
      ? null
      : Schema.decodeUnknownSync(Checkpoint)(JSON.parse(state.checkpoint));
  if (cp === null && now < state.nextAt) {
    return false;
  }
  const checkpoint: {
    -readonly [K in keyof typeof Checkpoint.Type]: (typeof Checkpoint.Type)[K];
  } = cp ?? {
    after: 0,
    before: Number.MAX_SAFE_INTEGER,
    current: null,
    cutoff: now,
    horizon: Schema.decodeUnknownSync(Count)(
      database
        .query(
          "SELECT COALESCE(MAX(sequence),0) AS value FROM lake_retention_identities WHERE principal='owner'"
        )
        .get()
    ).value,
    rank: 0,
    restarts: 0,
  };
  if (cp === null) {
    database
      .query("UPDATE lake_automatic_state SET startedAt=? WHERE id=1")
      .run(new Date(now).toISOString());
  }
  if (checkpoint.current === null) {
    const next = database
      .query(
        "SELECT sequence,artifactId,epoch FROM lake_retention_identities WHERE principal='owner' AND sequence>? AND sequence<=? ORDER BY sequence LIMIT 1"
      )
      .get(checkpoint.after, checkpoint.horizon);
    if (!next) {
      database
        .query(
          "UPDATE lake_automatic_state SET checkpoint=NULL,completedAt=?,nextAt=?,scanError=NULL WHERE id=1"
        )
        .run(new Date(now).toISOString(), now + 60_000);
      return false;
    }
    checkpoint.current = decodeIdentity(next);
    checkpoint.before = Number.MAX_SAFE_INTEGER;
    checkpoint.rank = 0;
    checkpoint.restarts = 0;
  }
  const { current } = checkpoint;
  const identity = decodeIdentity(
    database
      .query(
        "SELECT sequence,artifactId,epoch FROM lake_retention_identities WHERE sequence=?"
      )
      .get(current.sequence)
  );
  const finish = () => {
    checkpoint.after = identity.sequence;
    checkpoint.current = null;
  };
  if (identity.epoch !== current.epoch) {
    checkpoint.restarts += 1;
    if (checkpoint.restarts > 1) {
      finish();
      database
        .query(
          "UPDATE lake_automatic_state SET checkpoint=?,scanError=NULL WHERE id=1"
        )
        .run(canonical(checkpoint));
      return true;
    }
    checkpoint.before = Number.MAX_SAFE_INTEGER;
    checkpoint.rank = 0;
    checkpoint.current = identity;
  }
  const policy = capturedPolicy(database, identity.artifactId);
  if (policy.maxVersions === undefined && policy.maxAgeMillis === undefined) {
    finish();
  } else {
    const rows = Schema.decodeUnknownSync(Schema.Array(Row))(
      database
        .query(`
      SELECT sequence,version,committedAtMillis,json_extract(metadataJson,'$.digest') AS digest,json_extract(metadataJson,'$.bytes') AS bytes
      FROM lake_records WHERE artifactId=? AND reclaimedAt IS NULL AND version<=? ORDER BY version DESC LIMIT 128
    `)
        .all(identity.artifactId, checkpoint.before)
    );
    const approved: (typeof Row.Type)[] = [];
    for (const row of rows) {
      checkpoint.rank += 1;
      if (
        eligible(policy, row, checkpoint.rank, checkpoint.cutoff) &&
        !versionIsProtected(database, row.sequence)
      ) {
        approved.push(row);
      }
    }
    if (approved.length > 0) {
      const planId = crypto.randomUUID();
      database
        .query(
          "INSERT INTO lake_reclamation_plans(planId,principal,createdAt,expiresAt,requestJson,snapshot,candidatesJson,summaryJson) VALUES(?,'owner',?,?,?,0,'[]','{}')"
        )
        .run(planId, checkpoint.cutoff, now, canonical({ _tag: "Policy" }));
      commitReclamation(
        database,
        planId,
        "owner",
        approved,
        approved.length,
        now,
        "Automatic"
      );
      database
        .query(
          "UPDATE lake_automatic_state SET lastPlanId=?,lastBatchAt=? WHERE id=1"
        )
        .run(planId, new Date(now).toISOString());
      checkpoint.rank -= approved.length;
      checkpoint.current = decodeIdentity(
        database
          .query(
            "SELECT sequence,artifactId,epoch FROM lake_retention_identities WHERE sequence=?"
          )
          .get(identity.sequence)
      );
    }
    const last = rows.at(-1);
    if (rows.length < 128 || !last) {
      finish();
    } else {
      checkpoint.before = last.version - 1;
    }
  }
  database
    .query(
      "UPDATE lake_automatic_state SET checkpoint=?,scanError=NULL WHERE id=1"
    )
    .run(canonical(checkpoint));
  return true;
}

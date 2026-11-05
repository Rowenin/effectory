import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import type { WorkflowSchedule } from "@effectory/core";
import { canonical } from "@effectory/core/internal/boundary";
import { durationMillis } from "@effectory/core/internal/policy";
import { OperationError, terminal } from "@effectory/runtime/protocol";
import type { ScheduleProvenance, Run } from "@effectory/runtime/protocol";
import {
  MissedRange,
  ScheduleDescription,
  ScheduleError,
  ScheduleHistory,
  ScheduleHistoryEntry,
  ScheduleHistoryRequest,
  ScheduleList,
  ScheduleListRequest,
  SchedulePauseRequest,
  ScheduleReceipt,
  ScheduleResumeRequest,
  ScheduleSummary,
  SchedulerStatus,
} from "@effectory/runtime/schedule-protocol";
import { Cron, Schema } from "effect";

import type { Submit } from "./host-store.ts";
import type { createPagination } from "./pagination.ts";
import { dueSlots, eligibility, missedCountCap } from "./schedule-decision.ts";

const Configuration = Schema.Struct({
  catchUp: ScheduleDescription.fields.catchUp,
  catchUpMillis: Schema.NullOr(Schema.Finite),
  cron: Schema.String,
  description: Schema.NullOr(Schema.String),
  input: Schema.Json,
  scheduleId: Schema.String,
  timeZone: Schema.String,
  workflowId: Schema.String,
  workflowVersion: Schema.Int,
});
const Stored = Schema.Struct({
  activeRunId: Schema.NullOr(Schema.String),
  definitionJson: Schema.String,
  digest: Schema.String,
  errorJson: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  historyEpoch: Schema.Int,
  identity: Schema.Int,
  lastRunId: Schema.NullOr(Schema.String),
  pauseJson: Schema.NullOr(Schema.String),
  pendingSlot: Schema.NullOr(Schema.Finite),
  removed: Schema.Int,
  removedAt: Schema.NullOr(Schema.Finite),
  revision: Schema.String,
  scheduleId: Schema.String,
  watermark: Schema.Finite,
});
type StoredSchedule = typeof Stored.Type;
type ScheduleConfiguration = typeof Configuration.Type;
type MissedReason = (typeof MissedRange.Type)["reason"];
const HistoryRow = Schema.Struct({
  dataJson: Schema.String,
  sequence: Schema.Int,
});
const numberRow = Schema.Struct({ value: Schema.Int });
const iso = (now: number) => new Date(now).toISOString();
const fail = (code: OperationError["code"], message: string) =>
  new OperationError({ code, message });
const hash = (value: Schema.Json) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const decode = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  text: string
): S["Type"] => Schema.decodeUnknownSync(schema)(JSON.parse(text));
const config = (row: StoredSchedule) =>
  decode(Configuration, row.definitionJson);
const owner = (principal: string) => {
  if (principal !== "owner") {
    throw fail("NotFound", "Schedule was not found");
  }
};

function scheduleState(row: StoredSchedule, isBlocked: boolean) {
  if (row.removed) {
    return "Removed";
  }
  if (row.pauseJson !== null) {
    return "Paused";
  }
  return isBlocked ? "Blocked" : "Active";
}

export function createScheduleStore(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  host: {
    readonly getRun: (id: string) => Run;
    readonly accepting: () => boolean;
    readonly submit: (
      request: Submit,
      revision: string,
      principal: string,
      schedule: typeof ScheduleProvenance.Type,
      now: number
    ) => Run;
  }
) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS host_scheduler (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL, revision TEXT, errorJson TEXT);
    INSERT OR IGNORE INTO host_scheduler VALUES (1, 0, NULL, NULL);
    CREATE TABLE IF NOT EXISTS host_schedules (
      identity INTEGER PRIMARY KEY AUTOINCREMENT, scheduleId TEXT NOT NULL UNIQUE, definitionJson TEXT NOT NULL,
      digest TEXT NOT NULL, generation INTEGER NOT NULL, revision TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0, removedAt REAL,
      pauseJson TEXT, watermark REAL NOT NULL, activeRunId TEXT, lastRunId TEXT, errorJson TEXT, pendingSlot REAL, historyEpoch INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS host_schedule_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, scheduleId TEXT NOT NULL REFERENCES host_schedules(scheduleId) ON DELETE CASCADE, dataJson TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS host_schedule_history_id ON host_schedule_history(scheduleId, sequence);
    CREATE TABLE IF NOT EXISTS host_schedule_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, scheduleId TEXT NOT NULL REFERENCES host_schedules(scheduleId) ON DELETE CASCADE,
      actor TEXT NOT NULL, requestKey TEXT NOT NULL, fingerprint TEXT NOT NULL, receiptJson TEXT NOT NULL,
      UNIQUE(scheduleId, actor, requestKey)
    );
  `);
  const all = () =>
    database
      .query("SELECT * FROM host_schedules ORDER BY identity")
      .all()
      .map((raw) => Schema.decodeUnknownSync(Stored)(raw));
  const get = (id: string, activeRevision?: string) => {
    const raw = database
      .query("SELECT * FROM host_schedules WHERE scheduleId = ?")
      .get(id);
    if (!raw) {
      const current = Schema.decodeUnknownSync(
        Schema.Struct({ revision: Schema.NullOr(Schema.String) })
      )(database.query("SELECT revision FROM host_scheduler").get());
      throw fail(
        "NotFound",
        `Schedule was not found; scheduler revision ${current.revision ?? "not reconciled"}, active revision ${activeRevision ?? "unknown"}`
      );
    }
    return Schema.decodeUnknownSync(Stored)(raw);
  };
  const blocked = (row: StoredSchedule) => {
    if (row.activeRunId === null) {
      return null;
    }
    const run = host.getRun(row.activeRunId);
    return terminal.has(run.status)
      ? null
      : { runId: run.runId, status: run.status };
  };
  const summary = (row: StoredSchedule, now: number) => {
    const definition = config(row);
    const blockedBy = blocked(row);
    const last = row.lastRunId === null ? null : host.getRun(row.lastRunId);
    const missed = database
      .query(
        "SELECT dataJson FROM host_schedule_history WHERE scheduleId = ? AND json_extract(dataJson, '$._tag') = 'Missed' ORDER BY sequence DESC LIMIT 1"
      )
      .get(row.scheduleId);
    let lastError =
      row.errorJson === null ? null : decode(ScheduleError, row.errorJson);
    let nextScheduledAt: string | null = null;
    if (!row.removed && row.pauseJson === null) {
      try {
        nextScheduledAt = Cron.next(
          Cron.parseUnsafe(definition.cron, definition.timeZone),
          new Date(Math.max(now, row.watermark))
        ).toISOString();
      } catch {
        lastError = {
          at: iso(now),
          code: "InvalidInput",
          message: "Unable to calculate next scheduled occurrence",
        };
      }
    }
    return ScheduleSummary.make({
      blockedBy,
      cron: definition.cron,
      generation: row.generation,
      lastError,
      lastMissed: missed
        ? decode(
            MissedRange,
            Schema.decodeUnknownSync(
              Schema.Struct({ dataJson: Schema.String })
            )(missed).dataJson
          )
        : null,
      lastRun: last?.schedule
        ? {
            runId: last.runId,
            scheduledFor: last.schedule.scheduledFor,
            status: last.status,
          }
        : null,
      nextScheduledAt,
      scheduleId: row.scheduleId,
      state: scheduleState(row, blockedBy !== null),
      timeZone: definition.timeZone,
      workflowId: definition.workflowId,
    });
  };
  const history = (id: string, entry: typeof ScheduleHistoryEntry.Type) => {
    const last = database
      .query(
        "SELECT sequence, dataJson FROM host_schedule_history WHERE scheduleId = ? ORDER BY sequence DESC LIMIT 1"
      )
      .get(id);
    if (entry._tag === "Missed" && last) {
      const prior = Schema.decodeUnknownSync(HistoryRow)(last);
      const value = decode(ScheduleHistoryEntry, prior.dataJson);
      if (
        value._tag === "Missed" &&
        value.generation === entry.generation &&
        value.reason === entry.reason
      ) {
        const total = value.count + entry.count;
        database
          .query(
            "UPDATE host_schedule_history SET dataJson = ? WHERE sequence = ?"
          )
          .run(
            canonical({
              ...value,
              count: Math.min(total, missedCountCap),
              saturated:
                value.saturated || entry.saturated || total > missedCountCap,
              toSlot: entry.toSlot,
            }),
            prior.sequence
          );
        database
          .query(
            "UPDATE host_schedules SET historyEpoch = historyEpoch + 1 WHERE scheduleId = ?"
          )
          .run(id);
        return;
      }
    }
    database
      .query(
        "INSERT INTO host_schedule_history(scheduleId,dataJson) VALUES (?,?)"
      )
      .run(id, canonical(entry));
    const trimmed = database
      .query(
        "DELETE FROM host_schedule_history WHERE scheduleId = ? AND sequence NOT IN (SELECT sequence FROM host_schedule_history WHERE scheduleId = ? ORDER BY sequence DESC LIMIT 1000)"
      )
      .run(id, id);
    if (trimmed.changes) {
      database
        .query(
          "UPDATE host_schedules SET historyEpoch = historyEpoch + 1 WHERE scheduleId = ?"
        )
        .run(id);
    }
  };
  const missed = (
    row: StoredSchedule,
    first: number,
    last: number,
    count: number,
    saturated: boolean,
    reason: MissedReason
  ) => {
    if (count > 0) {
      history(row.scheduleId, {
        _tag: "Missed",
        count,
        fromSlot: iso(first),
        generation: row.generation,
        reason,
        saturated,
        scheduleId: row.scheduleId,
        toSlot: iso(last),
      });
    }
  };
  const recordError = (
    id: string | null,
    failure: OperationError,
    now: number
  ) => {
    const text = canonical({
      at: iso(now),
      code: failure.code,
      message: failure.message.slice(0, 2048),
    });
    if (id === null) {
      database.query("UPDATE host_scheduler SET errorJson = ?").run(text);
    } else {
      database
        .query("UPDATE host_schedules SET errorJson = ? WHERE scheduleId = ?")
        .run(text, id);
    }
  };
  const reconcile = (
    definitions: ReadonlyMap<string, WorkflowSchedule.Definition>,
    revision: string,
    now: number
  ) =>
    database.transaction(() => {
      if (!host.accepting()) {
        return;
      }
      const present = new Set(definitions.keys());
      for (const row of all()) {
        if (!present.has(row.scheduleId)) {
          database
            .query(
              "UPDATE host_schedules SET removed = 1, removedAt = COALESCE(removedAt, ?) WHERE scheduleId = ?"
            )
            .run(now, row.scheduleId);
        }
      }
      for (const definition of definitions.values()) {
        const value: ScheduleConfiguration = {
          catchUp: definition.catchUp,
          catchUpMillis:
            definition.catchUp === "skip"
              ? null
              : durationMillis(definition.catchUp.latestWithin),
          cron: definition.cron,
          description: definition.description ?? null,
          input: definition.encodedInput,
          scheduleId: definition.id,
          timeZone: definition.timeZone,
          workflowId: definition.workflow.id,
          workflowVersion: definition.workflow.spec.version,
        };
        const { description: _description, ...identity } = value;
        const digest = hash(identity);
        const raw = database
          .query("SELECT * FROM host_schedules WHERE scheduleId = ?")
          .get(definition.id);
        const prior = raw ? Schema.decodeUnknownSync(Stored)(raw) : null;
        if (!prior || prior.removed || prior.digest !== digest) {
          database
            .query("UPDATE host_scheduler SET generation = generation + 1")
            .run();
          const generation = Schema.decodeUnknownSync(numberRow)(
            database
              .query("SELECT generation AS value FROM host_scheduler")
              .get()
          ).value;
          database
            .query(`INSERT INTO host_schedules(scheduleId,definitionJson,digest,generation,revision,watermark) VALUES (?,?,?,?,?,?)
          ON CONFLICT(scheduleId) DO UPDATE SET definitionJson=excluded.definitionJson,digest=excluded.digest,generation=excluded.generation,revision=excluded.revision,removed=0,removedAt=NULL,watermark=excluded.watermark,pendingSlot=NULL,errorJson=NULL`)
            .run(
              definition.id,
              canonical(value),
              digest,
              generation,
              revision,
              now
            );
        } else {
          database
            .query(
              "UPDATE host_schedules SET revision = ?, definitionJson = ? WHERE scheduleId = ?"
            )
            .run(revision, canonical(value), definition.id);
        }
      }
      const removed = all()
        .filter((row) => row.removed)
        .toSorted(
          (left, right) =>
            (left.removedAt ?? 0) - (right.removedAt ?? 0) ||
            left.identity - right.identity
        );
      let remaining = removed.length - 1024;
      for (const row of removed) {
        if (remaining <= 0) {
          break;
        }
        if (row.pauseJson === null && blocked(row) === null) {
          database
            .query("DELETE FROM host_schedules WHERE scheduleId = ?")
            .run(row.scheduleId);
          remaining -= 1;
        }
      }
      if (remaining > 0) {
        throw fail(
          "LimitExceeded",
          "Removed schedule retention is full; resume an unblocked removed schedule to permit eviction"
        );
      }
      database
        .query("UPDATE host_scheduler SET revision = ?, errorJson = NULL")
        .run(revision);
    })();
  const tick = (id: string, now: number, restart: boolean) =>
    database.transaction(() => {
      if (!host.accepting()) {
        return;
      }
      const row = get(id);
      if (row.removed) {
        return;
      }
      const definition = config(row);
      const cron = Cron.parseUnsafe(definition.cron, definition.timeZone);
      const due = dueSlots(cron, row.watermark, now, row.pendingSlot);
      if (due === null) {
        return;
      }
      let unavailable: MissedReason | null = null;
      if (row.pauseJson !== null) {
        unavailable = "Paused";
      } else if (blocked(row) !== null) {
        unavailable = "Overlap";
      }
      let olderReason: MissedReason = restart ? "Downtime" : "Late";
      if (row.pendingSlot !== null) {
        olderReason = "AdmissionFailed";
      }
      const allowed = eligibility(now, due.latest, definition.catchUpMillis);
      if (unavailable !== null || allowed === "missed") {
        missed(
          row,
          due.first,
          due.latest,
          due.count,
          due.saturated,
          unavailable ?? olderReason
        );
      } else {
        if (due.first < due.latest) {
          missed(
            row,
            due.first,
            due.previous,
            due.saturated ? missedCountCap : due.count - 1,
            due.olderSaturated,
            olderReason
          );
        }
        const provenance = {
          catchUp: allowed === "catch-up",
          generation: row.generation,
          scheduleId: id,
          scheduledFor: iso(due.latest),
        };
        let run: Run;
        try {
          run = host.submit(
            {
              input: definition.input,
              kind: "workflow",
              requestKey: hash({
                generation: row.generation,
                scheduleId: id,
                scheduledFor: provenance.scheduledFor,
              }),
              revision: row.revision,
              targetId: definition.workflowId,
            },
            row.revision,
            "owner",
            provenance,
            now
          );
        } catch (error) {
          if (
            !(error instanceof OperationError) ||
            !["LimitExceeded", "Unavailable", "StorageFull"].includes(
              error.code
            )
          ) {
            throw error;
          }
          recordError(id, error, now);
          database
            .query(
              "UPDATE host_schedules SET pendingSlot = ?, watermark = ? WHERE scheduleId = ?"
            )
            .run(due.latest, due.latest - 1, id);
          return;
        }
        history(id, {
          _tag: "Admitted",
          ...provenance,
          runId: run.runId,
          status: run.status,
        });
        database
          .query(
            "UPDATE host_schedules SET activeRunId = ?, lastRunId = ?, pendingSlot = NULL WHERE scheduleId = ?"
          )
          .run(run.runId, run.runId, id);
      }
      database
        .query(
          "UPDATE host_schedules SET watermark = ?, pendingSlot = NULL, errorJson = NULL WHERE scheduleId = ?"
        )
        .run(due.latest, id);
    })();
  return {
    describe: (
      id: string,
      principal: string,
      now: number,
      activeRevision?: string
    ) => {
      owner(principal);
      const row = get(id, activeRevision);
      const definition = config(row);
      return ScheduleDescription.make({
        ...summary(row, now),
        catchUp: definition.catchUp,
        description: definition.description,
        input: definition.input,
        pause:
          row.pauseJson === null
            ? null
            : decode(ScheduleDescription.fields.pause, row.pauseJson),
        revision: row.revision,
      });
    },
    history: (
      input: typeof ScheduleHistoryRequest.Type,
      principal: string,
      now: number
    ) => {
      owner(principal);
      const { cursor, ...request } = Schema.decodeUnknownSync(
        ScheduleHistoryRequest
      )(input, { onExcessProperty: "error" });
      const row = get(request.scheduleId);
      const limit = request.limit ?? 50;
      const scope = {
        kind: "schedule-history",
        principal,
        query: { ...request, limit },
      };
      const token = pages.read(scope, cursor);
      const pinned = token
        ? Schema.decodeUnknownSync(
            Schema.Struct({
              epoch: Schema.Int,
              identity: Schema.Int,
              sequence: Schema.Int,
            })
          )(token.snapshot)
        : {
            epoch: row.historyEpoch,
            identity: row.identity,
            sequence: Schema.decodeUnknownSync(numberRow)(
              database
                .query(
                  "SELECT COALESCE(MAX(sequence),0) AS value FROM host_schedule_history WHERE scheduleId = ?"
                )
                .get(row.scheduleId)
            ).value,
          };
      if (
        pinned.epoch !== row.historyEpoch ||
        pinned.identity !== row.identity
      ) {
        throw fail(
          "CursorExpired",
          "Schedule history snapshot was coalesced or pruned; start a new history query"
        );
      }
      const after = token
        ? Schema.decodeUnknownSync(Schema.Int)(token.position)
        : 0;
      const raw = database
        .query(
          "SELECT sequence,dataJson FROM host_schedule_history WHERE scheduleId = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?"
        )
        .all(row.scheduleId, after, pinned.sequence, limit + 1)
        .map((item) => Schema.decodeUnknownSync(HistoryRow)(item));
      const items: (typeof ScheduleHistoryEntry.Type)[] = [];
      let bytes = 0;
      let position = after;
      for (const stored of raw) {
        const value = decode(ScheduleHistoryEntry, stored.dataJson);
        const entry =
          value._tag === "Admitted"
            ? { ...value, status: host.getRun(value.runId).status }
            : value;
        const size = Buffer.byteLength(canonical(entry));
        if (items.length >= limit || bytes + size > 1_048_576) {
          break;
        }
        items.push(entry);
        bytes += size;
        position = stored.sequence;
      }
      return ScheduleHistory.make({
        cursor:
          items.length < raw.length
            ? pages.write(
                scope,
                pinned,
                position,
                token?.expires ?? now + 3_600_000
              )
            : null,
        items,
        snapshot: pinned.sequence,
      });
    },
    ids: () =>
      all()
        .filter((row) => !row.removed)
        .map((row) => row.scheduleId),
    list: (
      input: typeof ScheduleListRequest.Type,
      principal: string,
      now: number
    ) => {
      owner(principal);
      const { cursor, ...request } = Schema.decodeUnknownSync(
        ScheduleListRequest
      )(input, { onExcessProperty: "error" });
      const limit = request.limit ?? 50;
      const scope = {
        kind: "schedules",
        principal,
        query: { ...request, limit },
      };
      const token = pages.read(scope, cursor);
      const snapshot = token
        ? Schema.decodeUnknownSync(Schema.Int)(token.snapshot)
        : Schema.decodeUnknownSync(numberRow)(
            database
              .query(
                "SELECT COALESCE(MAX(identity),0) AS value FROM host_schedules"
              )
              .get()
          ).value;
      const after = token
        ? Schema.decodeUnknownSync(Schema.Int)(token.position)
        : 0;
      const rows = all()
        .filter((row) => row.identity <= snapshot && row.identity > after)
        .map((row) => ({ identity: row.identity, value: summary(row, now) }))
        .filter(
          ({ value }) =>
            (request.workflowId === undefined ||
              value.workflowId === request.workflowId) &&
            (request.state === undefined
              ? value.state !== "Removed"
              : value.state === request.state)
        );
      const chosen: typeof rows = [];
      let bytes = 0;
      for (const row of rows) {
        const size = Buffer.byteLength(canonical(row.value));
        if (chosen.length >= limit || bytes + size > 1_048_576) {
          break;
        }
        chosen.push(row);
        bytes += size;
      }
      const last = chosen.at(-1);
      return ScheduleList.make({
        cursor:
          chosen.length < rows.length && last
            ? pages.write(
                scope,
                snapshot,
                last.identity,
                token?.expires ?? now + 3_600_000
              )
            : null,
        items: chosen.map((row) => row.value),
        snapshot,
      });
    },
    mutate: (
      input:
        | typeof SchedulePauseRequest.Type
        | typeof ScheduleResumeRequest.Type,
      paused: boolean,
      principal: string,
      now: number,
      activeRevision?: string
    ) =>
      database.transaction(() => {
        owner(principal);
        const request = Schema.decodeUnknownSync(
          paused ? SchedulePauseRequest : ScheduleResumeRequest
        )(input, { onExcessProperty: "error" });
        const row = get(request.scheduleId, activeRevision);
        const reason = paused
          ? (Schema.decodeUnknownSync(SchedulePauseRequest)(input).reason ??
            null)
          : null;
        if (reason !== null && Buffer.byteLength(reason) > 8192) {
          throw fail("LimitExceeded", "Pause reason exceeds 8 KiB");
        }
        const fingerprint = canonical({ paused, reason });
        const prior = database
          .query(
            "SELECT fingerprint, receiptJson FROM host_schedule_receipts WHERE scheduleId = ? AND actor = ? AND requestKey = ?"
          )
          .get(row.scheduleId, principal, request.requestKey);
        if (prior) {
          const receipt = Schema.decodeUnknownSync(
            Schema.Struct({
              fingerprint: Schema.String,
              receiptJson: Schema.String,
            })
          )(prior);
          if (receipt.fingerprint !== fingerprint) {
            throw fail(
              "Conflict",
              "Request key was used for a different schedule mutation"
            );
          }
          return decode(ScheduleReceipt, receipt.receiptJson);
        }
        const changed = (row.pauseJson !== null) !== paused;
        if (changed) {
          database
            .query(
              "UPDATE host_schedules SET pauseJson = ?, watermark = MAX(watermark, ?), pendingSlot = NULL WHERE scheduleId = ?"
            )
            .run(
              paused
                ? canonical({ actor: principal, at: iso(now), reason })
                : null,
              now,
              row.scheduleId
            );
        }
        const receipt = ScheduleReceipt.make({
          acceptedAt: iso(now),
          actor: principal,
          changed,
          generation: row.generation,
          operation: paused ? "Pause" : "Resume",
          paused,
          requestKey: request.requestKey,
          scheduleId: row.scheduleId,
        });
        database
          .query(
            "INSERT INTO host_schedule_receipts(scheduleId,actor,requestKey,fingerprint,receiptJson) VALUES (?,?,?,?,?)"
          )
          .run(
            row.scheduleId,
            principal,
            request.requestKey,
            fingerprint,
            canonical(receipt)
          );
        database
          .query(
            "DELETE FROM host_schedule_receipts WHERE scheduleId = ? AND sequence NOT IN (SELECT sequence FROM host_schedule_receipts WHERE scheduleId = ? ORDER BY sequence DESC LIMIT 256)"
          )
          .run(row.scheduleId, row.scheduleId);
        return receipt;
      })(),
    reconcile,
    recordError,
    status: (now: number) => {
      const meta = Schema.decodeUnknownSync(
        Schema.Struct({
          errorJson: Schema.NullOr(Schema.String),
          revision: Schema.NullOr(Schema.String),
        })
      )(database.query("SELECT revision,errorJson FROM host_scheduler").get());
      const values = all()
        .filter((row) => !row.removed)
        .map((row) => summary(row, now));
      const runningState = meta.revision === null ? "Stopped" : "Running";
      return SchedulerStatus.make({
        activeSchedules: values.filter((value) => value.state === "Active")
          .length,
        blockedSchedules: values.filter((value) => value.state === "Blocked")
          .length,
        lastError:
          meta.errorJson === null
            ? null
            : decode(ScheduleError, meta.errorJson),
        pausedSchedules: values.filter((value) => value.state === "Paused")
          .length,
        revision: meta.revision,
        state: host.accepting() ? runningState : "Draining",
      });
    },
    tick,
  };
}

import { Database } from "bun:sqlite";

import {
  canonical,
  checkJsonBudget,
  jsonLimits,
} from "@effectory/core/internal/boundary";
import { RunSummary } from "@effectory/runtime/history-protocol";
import type {
  LogListRequest,
  OutputListRequest,
  RunListRequest,
  EventListRequest,
  WaitListRequest,
} from "@effectory/runtime/history-protocol";
import {
  Event,
  CancellationRequest,
  CancellationReceipt,
  OperationError,
  Outbox,
  Run,
  terminal,
  Wait,
  WaitReceipt,
} from "@effectory/runtime/protocol";
import type {
  RunStatus,
  WaitOperation,
  ScheduleProvenance,
} from "@effectory/runtime/protocol";
import type { DrainRequest } from "@effectory/runtime/system-protocol";
import { Context, Effect, Layer, Schema } from "effect";

import {
  authorizeRun,
  eventPage,
  invocationScan,
  logPage,
  waitPage,
} from "./inspection.ts";
import { createLifecycle } from "./lifecycle.ts";
import { RepositoryLease } from "./ownership.ts";
import type { Lease } from "./ownership.ts";
import { createPagination } from "./pagination.ts";
import { runHistory } from "./run-history.ts";
import { createScheduleStore } from "./schedule-store.ts";
import { storageError } from "./storage-error.ts";

const RunRow = Schema.Struct({
  acceptedAt: Schema.String,
  engineId: Schema.NullOr(Schema.String),
  errorJson: Schema.NullOr(Schema.String),
  fingerprint: Schema.String,
  inputJson: Schema.String,
  kind: Schema.Literals(["task", "workflow"]),
  lastSequence: Schema.Int,
  principal: Schema.String,
  requestKey: Schema.String,
  resultJson: Schema.NullOr(Schema.String),
  revision: Schema.String,
  runId: Schema.String,
  scheduleJson: Schema.NullOr(Schema.String),
  status: Schema.String,
  targetId: Schema.String,
});
const WaitRow = Schema.Struct({
  contextJson: Schema.String,
  deadline: Schema.Finite,
  kind: Schema.String,
  nodeId: Schema.String,
  openedAt: Schema.String,
  payloadJson: Schema.NullOr(Schema.String),
  prompt: Schema.NullOr(Schema.String),
  runId: Schema.String,
  schemaJson: Schema.NullOr(Schema.String),
  status: Schema.String,
  waitId: Schema.String,
});

export interface Submit {
  readonly kind: "task" | "workflow";
  readonly targetId: string;
  readonly revision?: string;
  readonly input: Schema.Json;
  readonly requestKey: string;
}
export interface OpenWait {
  readonly runId: string;
  readonly nodeId: string;
  readonly kind: Wait["kind"];
  readonly deadline: number;
  readonly context: Schema.Json;
  readonly prompt?: string;
  readonly schema?: Schema.Json;
}
export interface SettleWait {
  readonly waitId: string;
  readonly operation: WaitOperation;
  readonly requestKey: string;
  readonly input?: Schema.Json;
}

function error(code: OperationError["code"], message: string): OperationError {
  return new OperationError({ code, message });
}

function json(value: string): Schema.Json {
  return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(value));
}

const waitOperations: Record<Wait["kind"], readonly WaitOperation[]> = {
  approval: ["approve", "reject"],
  input: ["respond"],
  signal: ["signal"],
};

function pageLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw error(
      "InvalidInput",
      "Page limit must be an integer between 1 and 200"
    );
  }
  return limit;
}

export function createStore(database: Database, lease: Lease) {
  const existingRunsTable = database
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'host_runs'"
    )
    .get();
  if (
    existingRunsTable &&
    !database
      .query("PRAGMA table_info(host_runs)")
      .all()
      .some(
        (column) =>
          Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(
            column
          ).name === "admissionNamespace"
      )
  ) {
    throw error(
      "RevisionUnavailable",
      "Host database uses an older admission format; use its original Effectory build and backup before upgrading"
    );
  }
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS host_page_secret (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), secret TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS host_runs (
      runId TEXT PRIMARY KEY, kind TEXT NOT NULL, targetId TEXT NOT NULL, revision TEXT NOT NULL,
      inputJson TEXT NOT NULL, principal TEXT NOT NULL, requestKey TEXT NOT NULL, fingerprint TEXT NOT NULL,
      engineId TEXT, status TEXT NOT NULL, acceptedAt TEXT NOT NULL, resultJson TEXT, errorJson TEXT,
      lastSequence INTEGER NOT NULL DEFAULT 0, admissionNamespace TEXT NOT NULL DEFAULT 'manual', scheduleJson TEXT, UNIQUE(principal, admissionNamespace, requestKey)
    );
    CREATE INDEX IF NOT EXISTS host_runs_status ON host_runs(status);
    CREATE INDEX IF NOT EXISTS host_runs_history ON host_runs(principal, acceptedAt DESC, runId ASC);
    CREATE TABLE IF NOT EXISTS host_invocations (
      runId TEXT NOT NULL REFERENCES host_runs(runId), nodeId TEXT NOT NULL, engineId TEXT NOT NULL, payloadJson TEXT NOT NULL,
      PRIMARY KEY(runId, nodeId)
    );
    CREATE TABLE IF NOT EXISTS host_fences (runId TEXT PRIMARY KEY REFERENCES host_runs(runId), reasonJson TEXT, requestedAt REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS host_events (
      runId TEXT NOT NULL REFERENCES host_runs(runId), sequence INTEGER NOT NULL, eventKey TEXT NOT NULL,
      at TEXT NOT NULL, tag TEXT NOT NULL, payloadJson TEXT NOT NULL,
      PRIMARY KEY(runId, sequence), UNIQUE(runId, eventKey)
    );
    CREATE INDEX IF NOT EXISTS host_event_tag ON host_events(runId, tag, sequence);
    CREATE TABLE IF NOT EXISTS host_telemetry_budget (
      runId TEXT PRIMARY KEY REFERENCES host_runs(runId), entries INTEGER NOT NULL, bytes INTEGER NOT NULL, truncated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_waits (
      waitId TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES host_runs(runId), nodeId TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, openedAt TEXT NOT NULL, deadline REAL NOT NULL,
      contextJson TEXT NOT NULL, prompt TEXT, schemaJson TEXT, payloadJson TEXT, UNIQUE(runId, nodeId)
    );
    CREATE INDEX IF NOT EXISTS host_wait_status ON host_waits(status);
    CREATE TABLE IF NOT EXISTS host_receipts (
      waitId TEXT NOT NULL REFERENCES host_waits(waitId), requestKey TEXT NOT NULL, actor TEXT NOT NULL,
      fingerprint TEXT NOT NULL, receiptJson TEXT NOT NULL, PRIMARY KEY(waitId, requestKey)
    );
    CREATE TABLE IF NOT EXISTS host_cancellation_receipts (
      runId TEXT NOT NULL REFERENCES host_runs(runId), requestKey TEXT NOT NULL, actor TEXT NOT NULL,
      fingerprint TEXT NOT NULL, receiptJson TEXT NOT NULL, PRIMARY KEY(runId, requestKey, actor)
    );
    CREATE TABLE IF NOT EXISTS host_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, runId TEXT NOT NULL REFERENCES host_runs(runId),
      waitId TEXT, intentKey TEXT NOT NULL UNIQUE, delivered INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS host_outbox_pending ON host_outbox(delivered, id);
    CREATE TABLE IF NOT EXISTS host_attempts (
      runId TEXT NOT NULL REFERENCES host_runs(runId), nodeId TEXT NOT NULL, activityAttempt INTEGER NOT NULL,
      owner TEXT NOT NULL, entries INTEGER NOT NULL, startedAt REAL NOT NULL, PRIMARY KEY(runId, nodeId, activityAttempt)
    );
  `);

  database
    .query("INSERT OR IGNORE INTO host_page_secret VALUES (1, ?)")
    .run(crypto.randomUUID());
  const { secret } = Schema.decodeUnknownSync(
    Schema.Struct({ secret: Schema.String })
  )(
    database
      .query("SELECT secret FROM host_page_secret WHERE singleton = 1")
      .get()
  );
  const pagination = createPagination(secret);
  const lifecycle = createLifecycle(database);
  let storageFailures = 0;
  const perform = <A>(body: () => A) =>
    Effect.try({
      catch: (cause) => {
        const failure = storageError(
          cause,
          "Persistent store operation failed"
        );
        if (failure.code === "StorageFull") {
          storageFailures += 1;
        }
        return failure;
      },
      try: () => {
        lease.assertActive();
        return body();
      },
    });
  const getRun = (runId: string): Run => {
    const raw = database
      .query("SELECT * FROM host_runs WHERE runId = ?")
      .get(runId);
    if (!raw) {
      throw error("NotFound", `Run not found: ${runId}`);
    }
    const row = Schema.decodeUnknownSync(RunRow)(raw);
    return Schema.decodeUnknownSync(Run)({
      ...row,
      error: row.errorJson === null ? null : json(row.errorJson),
      input: json(row.inputJson),
      result: row.resultJson === null ? null : json(row.resultJson),
      ...(row.scheduleJson === null
        ? {}
        : { schedule: json(row.scheduleJson) }),
    });
  };
  const getWait = (waitId: string): Wait => {
    const raw = database
      .query("SELECT * FROM host_waits WHERE waitId = ?")
      .get(waitId);
    if (!raw) {
      throw error("NotFound", `Wait not found: ${waitId}`);
    }
    const row = Schema.decodeUnknownSync(WaitRow)(raw);
    return Schema.decodeUnknownSync(Wait)({
      ...row,
      context: json(row.contextJson),
      payload: row.payloadJson === null ? null : json(row.payloadJson),
      schema: row.schemaJson === null ? null : json(row.schemaJson),
    });
  };
  const event = (
    runId: string,
    key: string,
    tag: string,
    payload: Schema.Json
  ) => {
    if (
      database
        .query(
          "SELECT sequence FROM host_events WHERE runId = ? AND eventKey = ?"
        )
        .get(runId, key)
    ) {
      return;
    }
    const sequence = getRun(runId).lastSequence + 1;
    database
      .query("INSERT INTO host_events VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        runId,
        sequence,
        key,
        new Date().toISOString(),
        tag,
        canonical(payload)
      );
    database
      .query("UPDATE host_runs SET lastSequence = ? WHERE runId = ?")
      .run(sequence, runId);
  };
  let telemetryWriteFailures = 0;
  const telemetry = (
    runId: string,
    key: string,
    tag: "Log" | "Progress",
    payload: Schema.Json
  ) => {
    try {
      lease.assertActive();
      database.transaction(() => {
        if (terminal.has(getRun(runId).status)) {
          return;
        }
        if (
          database
            .query(
              "SELECT sequence FROM host_events WHERE runId = ? AND eventKey = ?"
            )
            .get(runId, key)
        ) {
          return;
        }
        database
          .query(
            "INSERT OR IGNORE INTO host_telemetry_budget VALUES (?, 0, 0, 0)"
          )
          .run(runId);
        const budget = Schema.decodeUnknownSync(
          Schema.Struct({
            bytes: Schema.Int,
            entries: Schema.Int,
            truncated: Schema.Int,
          })
        )(
          database
            .query(
              "SELECT entries, bytes, truncated FROM host_telemetry_budget WHERE runId = ?"
            )
            .get(runId)
        );
        if (budget.truncated) {
          return;
        }
        let bytes = 8193;
        try {
          checkJsonBudget(payload, { ...jsonLimits, bytes: 8192 });
          bytes = Buffer.byteLength(canonical(payload));
        } catch {
          /* Record one bounded truncation marker below. */
        }
        if (
          bytes > 8192 ||
          budget.entries >= 1000 ||
          budget.bytes + bytes > 1_048_576
        ) {
          event(runId, "telemetry/truncated", "TelemetryTruncated", {
            code: "LimitExceeded",
            message:
              "Task logs/progress exceeded 8 KiB per entry, 1000 entries or 1 MiB per run",
          });
          database
            .query(
              "UPDATE host_telemetry_budget SET truncated = 1 WHERE runId = ?"
            )
            .run(runId);
          return;
        }
        event(runId, key, tag, payload);
        database
          .query(
            "UPDATE host_telemetry_budget SET entries = entries + 1, bytes = bytes + ? WHERE runId = ?"
          )
          .run(bytes, runId);
      })();
    } catch {
      // Telemetry is best effort and must not replay a task after an external
      // effect. The read-only doctor reports failed writes without their data.
      telemetryWriteFailures = Math.min(
        Number.MAX_SAFE_INTEGER,
        telemetryWriteFailures + 1
      );
    }
  };
  const enqueue = (
    kind: Outbox["kind"],
    runId: string,
    waitId: string | null = null
  ) => {
    database
      .query(
        "INSERT OR IGNORE INTO host_outbox(kind, runId, waitId, intentKey) VALUES (?, ?, ?, ?)"
      )
      .run(kind, runId, waitId, `${kind}/${runId}/${waitId ?? ""}`);
  };
  const closeWait = (
    wait: Wait,
    status: Wait["status"],
    payload: Schema.Json | null
  ) => {
    if (wait.status !== "Open") {
      return;
    }
    database
      .query(
        "UPDATE host_waits SET status = ?, payloadJson = ? WHERE waitId = ? AND status = 'Open'"
      )
      .run(status, payload === null ? null : canonical(payload), wait.waitId);
    if (status === "Rejected" || status === "TimedOut") {
      database
        .query(
          "INSERT INTO host_fences VALUES (?, ?, ?) ON CONFLICT(runId) DO UPDATE SET reasonJson = COALESCE(host_fences.reasonJson, excluded.reasonJson)"
        )
        .run(
          wait.runId,
          canonical({
            _tag: "ExecutionFailure",
            category: "Control",
            detail: payload,
            outcome: status,
          }),
          Date.now()
        );
    }
    enqueue("Settle", wait.runId, wait.waitId);
    event(wait.runId, `wait/${wait.waitId}/settled`, "WaitSettled", {
      status,
      waitId: wait.waitId,
    });
  };

  const cancelRun = (
    runId: string,
    reason: string | null = null,
    actor = "system"
  ) => {
    const run = getRun(runId);
    if (terminal.has(run.status)) {
      return run;
    }
    database
      .query("UPDATE host_runs SET status = 'Cancelling' WHERE runId = ?")
      .run(runId);
    database
      .query(
        "INSERT INTO host_fences VALUES (?, ?, ?) ON CONFLICT(runId) DO UPDATE SET reasonJson = COALESCE(host_fences.reasonJson, excluded.reasonJson)"
      )
      .run(
        runId,
        canonical({
          _tag: "ExecutionFailure",
          category: "Control",
          detail: reason === null ? null : { reason },
          outcome: "Cancelled",
        }),
        Date.now()
      );
    const waits = database
      .query(
        "SELECT waitId FROM host_waits WHERE runId = ? AND status = 'Open'"
      )
      .all(runId);
    for (const raw of waits) {
      closeWait(
        getWait(
          Schema.decodeUnknownSync(Schema.Struct({ waitId: Schema.String }))(
            raw
          ).waitId
        ),
        "Cancelled",
        null
      );
    }
    enqueue("Cancel", runId);
    event(runId, "cancel", "CancellationRequested", { actor, reason });
    return getRun(runId);
  };

  const submitRun = (
    request: Submit,
    resolvedRevision: string,
    principal: string,
    schedule?: typeof ScheduleProvenance.Type,
    now?: number
  ) =>
    database.transaction(() => {
      const fingerprint = canonical({
        input: request.input,
        kind: request.kind,
        revision: request.revision ?? null,
        targetId: request.targetId,
      });
      const prior = database
        .query(
          "SELECT * FROM host_runs WHERE principal = ? AND admissionNamespace = ? AND requestKey = ?"
        )
        .get(
          principal,
          schedule === undefined ? "manual" : "schedule",
          request.requestKey
        );
      if (prior) {
        const row = Schema.decodeUnknownSync(RunRow)(prior);
        if (row.fingerprint !== fingerprint) {
          throw error(
            "Conflict",
            "Request key was used for another submission"
          );
        }
        return getRun(row.runId);
      }
      if (!lifecycle.accepting) {
        throw error("Unavailable", "Daemon is draining");
      }
      if (
        Buffer.byteLength(canonical(request.input)) > 1_048_576 ||
        request.requestKey.length < 1 ||
        request.requestKey.length > 200
      ) {
        throw error(
          "LimitExceeded",
          "Submission exceeds the input or request-key limit"
        );
      }
      const { count } = Schema.decodeUnknownSync(
        Schema.Struct({ count: Schema.Int })
      )(
        database
          .query(
            "SELECT COUNT(*) AS count FROM host_runs WHERE status NOT IN ('Succeeded','Failed','Rejected','TimedOut','Cancelled')"
          )
          .get()
      );
      if (count >= 1000) {
        throw error("LimitExceeded", "Repository already has 1000 active runs");
      }
      const runId = crypto.randomUUID();
      database
        .query(
          "INSERT INTO host_runs(runId, kind, targetId, revision, inputJson, principal, requestKey, fingerprint, status, acceptedAt, admissionNamespace, scheduleJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Queued', ?, ?, ?)"
        )
        .run(
          runId,
          request.kind,
          request.targetId,
          resolvedRevision,
          canonical(request.input),
          principal,
          request.requestKey,
          fingerprint,
          new Date(now ?? Date.now()).toISOString(),
          schedule === undefined ? "manual" : "schedule",
          schedule === undefined ? null : canonical(schedule)
        );
      enqueue("Dispatch", runId);
      event(runId, "accepted", "RunAccepted", {
        revision: resolvedRevision,
      });
      return getRun(runId);
    })();
  const schedules = createScheduleStore(database, pagination, {
    accepting: () => lifecycle.accepting,
    getRun,
    submit: submitRun,
  });
  const scheduleCall =
    <K extends keyof typeof schedules>(key: K) =>
    (...args: Parameters<(typeof schedules)[K]>) =>
      perform(() => {
        // All schedule operations are synchronous and serialized by the host's lease.
        const operation = schedules[key] as (
          ...values: Parameters<(typeof schedules)[K]>
        ) => ReturnType<(typeof schedules)[K]>;
        return operation(...args);
      });
  return {
    acknowledge: (id: number) =>
      perform(() => {
        database
          .query("UPDATE host_outbox SET delivered = 1 WHERE id = ?")
          .run(id);
      }),
    activeRuns: (after = "") =>
      perform(() =>
        database
          .query(
            "SELECT runId FROM host_runs WHERE status NOT IN ('Succeeded','Failed','Rejected','TimedOut','Cancelled') AND runId > ? ORDER BY runId LIMIT 200"
          )
          .all(after)
          .map((raw) =>
            getRun(
              Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }))(
                raw
              ).runId
            )
          )
      ),
    admitAttempt: (
      runId: string,
      nodeId: string,
      activityAttempt: number,
      replay: "manual" | "idempotent",
      policy: {
        readonly deadline?: number;
        readonly attemptTimeout?: number;
      } = {}
    ) =>
      perform(() =>
        database.transaction(() => {
          const run = getRun(runId);
          if (
            terminal.has(run.status) ||
            run.status === "Cancelling" ||
            database
              .query("SELECT runId FROM host_fences WHERE runId = ?")
              .get(runId)
          ) {
            return "Cancelled" as const;
          }
          if (run.status === "NeedsAttention") {
            return "NeedsAttention" as const;
          }
          const prior = database
            .query(
              "SELECT entries, startedAt FROM host_attempts WHERE runId = ? AND nodeId = ? AND activityAttempt = ?"
            )
            .get(runId, nodeId, activityAttempt);
          const startedAt = prior
            ? Schema.decodeUnknownSync(
                Schema.Struct({ startedAt: Schema.Finite })
              )(prior).startedAt
            : Date.now();
          const deadline = Math.min(
            policy.deadline ?? Number.POSITIVE_INFINITY,
            policy.attemptTimeout === undefined
              ? Number.POSITIVE_INFINITY
              : startedAt + policy.attemptTimeout
          );
          if (Date.now() >= deadline) {
            database
              .query(
                "INSERT INTO host_fences VALUES (?, ?, ?) ON CONFLICT(runId) DO UPDATE SET reasonJson = COALESCE(host_fences.reasonJson, excluded.reasonJson)"
              )
              .run(
                runId,
                canonical({
                  _tag: "ExecutionFailure",
                  category: "Control",
                  detail: { deadline, nodeId },
                  outcome: "TimedOut",
                }),
                Date.now()
              );
            return "TimedOut" as const;
          }
          if (prior && replay === "manual") {
            database
              .query(
                "UPDATE host_runs SET status = 'NeedsAttention' WHERE runId = ?"
              )
              .run(runId);
            event(
              runId,
              `attention/${nodeId}/${activityAttempt}`,
              "NeedsAttention",
              { nodeId }
            );
            return "NeedsAttention" as const;
          }
          database
            .query(
              "INSERT INTO host_attempts VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(runId, nodeId, activityAttempt) DO UPDATE SET owner = excluded.owner, entries = entries + 1"
            )
            .run(runId, nodeId, activityAttempt, lease.token, startedAt);
          event(
            runId,
            `attempt/${nodeId}/${activityAttempt}`,
            "AttemptStarted",
            {
              attempt: activityAttempt,
              deadline: Number.isFinite(deadline) ? deadline : null,
              nodeId,
              startedAt,
            }
          );
          return "Admitted" as const;
        })()
      ),
    appendEvent: (
      runId: string,
      key: string,
      tag: string,
      payload: Schema.Json
    ) =>
      perform(() =>
        database.transaction(() => {
          if (Buffer.byteLength(canonical(payload)) > 8192) {
            throw error("LimitExceeded", "Event exceeds 8 KiB");
          }
          event(runId, key, tag, payload);
        })()
      ),
    attemptStartedAt: (runId: string, nodeId: string, attempt: number) =>
      perform(
        () =>
          Schema.decodeUnknownSync(Schema.Struct({ startedAt: Schema.Finite }))(
            database
              .query(
                "SELECT startedAt FROM host_attempts WHERE runId = ? AND nodeId = ? AND activityAttempt = ?"
              )
              .get(runId, nodeId, attempt)
          ).startedAt
      ),
    beginInstance: (instanceId: string) =>
      perform(() => lifecycle.begin(instanceId)),
    cancel: (runId: string) =>
      perform(() => database.transaction(() => cancelRun(runId))()),
    cancelRequest: (value: typeof CancellationRequest.Type, actor: string) =>
      perform(() =>
        database.transaction(() => {
          if (!Schema.is(CancellationRequest)(value)) {
            throw error("InvalidInput", "Invalid cancellation request");
          }
          const request = Schema.decodeUnknownSync(CancellationRequest)(value, {
            onExcessProperty: "error",
          });
          const authorized = database
            .query(
              "SELECT runId FROM host_runs WHERE runId = ? AND principal = ?"
            )
            .get(request.runId, actor);
          if (!authorized) {
            throw error("NotFound", "Run was not found");
          }
          const reason = request.reason ?? null;
          const fingerprint = canonical({ reason });
          const previous = database
            .query(
              "SELECT fingerprint, receiptJson FROM host_cancellation_receipts WHERE runId = ? AND requestKey = ? AND actor = ?"
            )
            .get(request.runId, request.requestKey, actor);
          if (previous) {
            const row = Schema.decodeUnknownSync(
              Schema.Struct({
                fingerprint: Schema.String,
                receiptJson: Schema.String,
              })
            )(previous);
            if (row.fingerprint !== fingerprint) {
              throw error(
                "Conflict",
                "Cancellation request key was already used with a different reason"
              );
            }
            return Schema.decodeUnknownSync(CancellationReceipt)(
              JSON.parse(row.receiptJson)
            );
          }
          const { count } = Schema.decodeUnknownSync(
            Schema.Struct({ count: Schema.Int })
          )(
            database
              .query(
                "SELECT COUNT(*) AS count FROM host_cancellation_receipts WHERE runId = ?"
              )
              .get(request.runId)
          );
          if (count >= 64) {
            throw error(
              "LimitExceeded",
              "Cancellation receipt limit reached for this run (64)"
            );
          }
          const run = cancelRun(request.runId, reason, actor);
          const receipt: typeof CancellationReceipt.Type = {
            acceptedAt: new Date().toISOString(),
            actor,
            reason,
            requestKey: request.requestKey,
            runId: request.runId,
            status: run.status,
          };
          database
            .query(
              "INSERT INTO host_cancellation_receipts VALUES (?, ?, ?, ?, ?)"
            )
            .run(
              request.runId,
              request.requestKey,
              actor,
              fingerprint,
              JSON.stringify(receipt)
            );
          return receipt;
        })()
      ),
    daemonStatus: () => perform(() => lifecycle.status()),
    drain: (request: typeof DrainRequest.Type) =>
      perform(() => lifecycle.drain(request)),
    eventPage: (request: typeof EventListRequest.Type, principal: string) =>
      perform(() =>
        database.transaction(() =>
          eventPage(database, pagination, request, principal)
        )()
      ),
    events: (runId: string, after = 0, limit = 50) =>
      perform(() => {
        getRun(runId);
        if (!Number.isSafeInteger(after) || after < 0) {
          throw error(
            "InvalidInput",
            "Event sequence must be a nonnegative integer"
          );
        }
        return database
          .query(
            "SELECT * FROM host_events WHERE runId = ? AND sequence > ? ORDER BY sequence LIMIT ?"
          )
          .all(runId, after, pageLimit(limit))
          .map((raw) => {
            const row = Schema.decodeUnknownSync(
              Schema.Struct({
                at: Schema.String,
                payloadJson: Schema.String,
                runId: Schema.String,
                sequence: Schema.Int,
                tag: Schema.String,
              })
            )(raw);
            return Schema.decodeUnknownSync(Event)({
              ...row,
              payload: json(row.payloadJson),
            });
          });
      }),
    expire: (now = Date.now()) =>
      perform(() =>
        database.transaction(() => {
          const expired = database
            .query(
              "SELECT waitId FROM host_waits WHERE status = 'Open' AND deadline <= ? ORDER BY deadline LIMIT 200"
            )
            .all(now);
          for (const raw of expired) {
            closeWait(
              getWait(
                Schema.decodeUnknownSync(
                  Schema.Struct({ waitId: Schema.String })
                )(raw).waitId
              ),
              "TimedOut",
              null
            );
          }
          return expired.length;
        })()
      ),
    fence: (runId: string, reason: Schema.Json = null) =>
      perform(() =>
        database.transaction(() => {
          database
            .query(
              "INSERT INTO host_fences VALUES (?, ?, ?) ON CONFLICT(runId) DO UPDATE SET reasonJson = COALESCE(host_fences.reasonJson, excluded.reasonJson)"
            )
            .run(runId, reason === null ? null : canonical(reason), Date.now());
          const waits = database
            .query(
              "SELECT waitId FROM host_waits WHERE runId = ? AND status = 'Open'"
            )
            .all(runId);
          for (const raw of waits) {
            closeWait(
              getWait(
                Schema.decodeUnknownSync(
                  Schema.Struct({ waitId: Schema.String })
                )(raw).waitId
              ),
              "Cancelled",
              null
            );
          }
        })()
      ),
    fenceReason: (runId: string) =>
      perform(() => {
        const row = database
          .query("SELECT reasonJson FROM host_fences WHERE runId = ?")
          .get(runId);
        if (!row) {
          return null;
        }
        const { reasonJson } = Schema.decodeUnknownSync(
          Schema.Struct({ reasonJson: Schema.NullOr(Schema.String) })
        )(row);
        return reasonJson === null ? null : json(reasonJson);
      }),
    fenceRequestedAt: (runId: string) =>
      perform(() => {
        const row = database
          .query("SELECT requestedAt FROM host_fences WHERE runId = ?")
          .get(runId);
        return row
          ? Schema.decodeUnknownSync(
              Schema.Struct({ requestedAt: Schema.Finite })
            )(row).requestedAt
          : null;
      }),
    getRun: (runId: string, principal?: string) =>
      perform(() => {
        if (principal !== undefined) {
          authorizeRun(database, runId, principal);
        }
        return getRun(runId);
      }),
    getWait: (waitId: string, principal?: string) =>
      perform(() => {
        if (
          principal !== undefined &&
          !database
            .query(
              "SELECT w.waitId FROM host_waits w JOIN host_runs r ON r.runId = w.runId WHERE w.waitId = ? AND r.principal = ?"
            )
            .get(waitId, principal)
        ) {
          throw error("NotFound", "Wait was not found");
        }
        return getWait(waitId);
      }),
    health: () =>
      perform(() => ({
        counts: {
          activeRuns: database
            .query(
              "SELECT runId FROM host_runs WHERE status IN ('Queued','Running','Waiting','Retrying','Cancelling','NeedsAttention') LIMIT 1001"
            )
            .all().length,
          openWaitsLowerBound: database
            .query(
              "SELECT waitId FROM host_waits WHERE status = 'Open' LIMIT 1001"
            )
            .all().length,
          pendingDeliveriesLowerBound: database
            .query("SELECT id FROM host_outbox WHERE delivered = 0 LIMIT 1001")
            .all().length,
        },
        storage: {
          freePages: Schema.decodeUnknownSync(
            Schema.Struct({ freelist_count: Schema.Int })
          )(database.query("PRAGMA freelist_count").get()).freelist_count,
          pageCount: Schema.decodeUnknownSync(
            Schema.Struct({ page_count: Schema.Int })
          )(database.query("PRAGMA page_count").get()).page_count,
          pageSize: Schema.decodeUnknownSync(
            Schema.Struct({ page_size: Schema.Int })
          )(database.query("PRAGMA page_size").get()).page_size,
        },
      })),
    history: (request: typeof RunListRequest.Type, principal: string) =>
      perform(() => runHistory(database, pagination, request, principal)),
    invocationScan: (
      request: typeof OutputListRequest.Type,
      principal: string
    ) =>
      perform(() =>
        database.transaction(() =>
          invocationScan(database, pagination, request, principal)
        )()
      ),
    invocations: (runId: string) =>
      perform(() =>
        Schema.decodeUnknownSync(
          Schema.Array(
            Schema.Struct({
              engineId: Schema.String,
              nodeId: Schema.String,
              payloadJson: Schema.String,
            })
          )
        )(
          database
            .query(
              "SELECT nodeId, engineId, payloadJson FROM host_invocations WHERE runId = ? ORDER BY nodeId LIMIT 10000"
            )
            .all(runId)
        )
      ),
    listRuns: (limit = 50) =>
      perform(() =>
        database
          .query(
            "SELECT runId FROM host_runs ORDER BY acceptedAt DESC, runId LIMIT ?"
          )
          .all(pageLimit(limit))
          .map((raw) =>
            getRun(
              Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }))(
                raw
              ).runId
            )
          )
      ),
    listWaits: (runId: string, limit = 50) =>
      perform(() => {
        getRun(runId);
        return database
          .query(
            "SELECT waitId FROM host_waits WHERE runId = ? ORDER BY openedAt, waitId LIMIT ?"
          )
          .all(runId, pageLimit(limit))
          .map((raw) =>
            getWait(
              Schema.decodeUnknownSync(
                Schema.Struct({ waitId: Schema.String })
              )(raw).waitId
            )
          );
      }),
    logPage: (request: typeof LogListRequest.Type, principal: string) =>
      perform(() =>
        database.transaction(() =>
          logPage(database, pagination, request, principal)
        )()
      ),
    lookupSubmission: (request: Submit, principal: string) =>
      perform(() => {
        const prior = database
          .query(
            "SELECT * FROM host_runs WHERE principal = ? AND admissionNamespace = 'manual' AND requestKey = ?"
          )
          .get(principal, request.requestKey);
        if (!prior) {
          return null;
        }
        const row = Schema.decodeUnknownSync(RunRow)(prior);
        if (
          row.fingerprint !==
          canonical({
            input: request.input,
            kind: request.kind,
            revision: request.revision ?? null,
            targetId: request.targetId,
          })
        ) {
          throw error(
            "Conflict",
            "Request key was used for another submission"
          );
        }
        return getRun(row.runId);
      }),
    observation: (runId: string, principal: string, after = 0) =>
      perform(() =>
        database.transaction(() => {
          const raw = database
            .query(
              "SELECT runId, targetId, kind, revision, acceptedAt, status, lastSequence, scheduleJson FROM host_runs WHERE runId = ? AND principal = ?"
            )
            .get(runId, principal);
          if (!raw) {
            throw error("NotFound", "Run was not found");
          }
          const storedSchedule = Schema.decodeUnknownSync(
            Schema.Struct({ scheduleJson: Schema.NullOr(Schema.String) })
          )(raw).scheduleJson;
          const run = Schema.decodeUnknownSync(RunSummary)({
            ...raw,
            ...(storedSchedule === null
              ? {}
              : { schedule: json(storedSchedule) }),
          });
          if (
            !Number.isSafeInteger(after) ||
            after < 0 ||
            after > run.lastSequence
          ) {
            throw error(
              "InvalidInput",
              "Watch sequence must be within the recorded event range"
            );
          }
          const events = database
            .query(
              "SELECT at, payloadJson, runId, sequence, tag FROM host_events WHERE runId = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 16"
            )
            .all(runId, after, run.lastSequence)
            .map((value) => {
              const row = Schema.decodeUnknownSync(
                Schema.Struct({
                  at: Schema.String,
                  payloadJson: Schema.String,
                  runId: Schema.String,
                  sequence: Schema.Int,
                  tag: Schema.String,
                })
              )(value);
              return {
                at: row.at,
                payload: json(row.payloadJson),
                runId: row.runId,
                sequence: row.sequence,
                tag: row.tag,
              };
            });
          return { events, run };
        })()
      ),
    openWait: (input: OpenWait) =>
      perform(() =>
        database.transaction(() => {
          const existing = database
            .query(
              "SELECT waitId FROM host_waits WHERE runId = ? AND nodeId = ?"
            )
            .get(input.runId, input.nodeId);
          if (existing) {
            return getWait(
              Schema.decodeUnknownSync(
                Schema.Struct({ waitId: Schema.String })
              )(existing).waitId
            );
          }
          try {
            checkJsonBudget(input.context, { ...jsonLimits, bytes: 65_536 });
            if (input.schema !== undefined) {
              checkJsonBudget(input.schema, { ...jsonLimits, bytes: 65_536 });
            }
            if (
              input.prompt !== undefined &&
              Buffer.byteLength(input.prompt) > 8192
            ) {
              throw error("LimitExceeded", "Wait prompt exceeds 8 KiB");
            }
          } catch {
            throw error(
              "LimitExceeded",
              "Wait context/schema exceeds 64 KiB, prompt exceeds 8 KiB, or JSON depth/value limit exceeded"
            );
          }
          const run = getRun(input.runId);
          if (
            terminal.has(run.status) ||
            run.status === "Cancelling" ||
            database
              .query("SELECT runId FROM host_fences WHERE runId = ?")
              .get(input.runId)
          ) {
            throw error("WaitClosed", "Run no longer admits waits");
          }
          const waitId = crypto.randomUUID();
          database
            .query(
              "INSERT INTO host_waits VALUES (?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?, NULL)"
            )
            .run(
              waitId,
              input.runId,
              input.nodeId,
              input.kind,
              new Date().toISOString(),
              input.deadline,
              canonical(input.context),
              input.prompt ?? null,
              input.schema === undefined ? null : canonical(input.schema)
            );
          event(input.runId, `wait/${waitId}/opened`, "WaitOpened", {
            nodeId: input.nodeId,
            waitId,
          });
          return getWait(waitId);
        })()
      ),
    outbox: () =>
      perform(() =>
        Schema.decodeUnknownSync(Schema.Array(Outbox))(
          database
            .query(
              "SELECT o.id, o.kind, o.runId, o.waitId FROM host_outbox o JOIN host_runs r ON r.runId = o.runId WHERE o.delivered = 0 AND (o.kind != 'Settle' OR r.status != 'NeedsAttention') ORDER BY o.id LIMIT 200"
            )
            .all()
        )
      ),
    pagination,
    project: (runId: string, status: RunStatus, payload: Schema.Json = null) =>
      perform(() =>
        database.transaction(() => {
          const run = getRun(runId);
          if (terminal.has(run.status) || run.status === status) {
            return run;
          }
          database
            .query(
              "UPDATE host_runs SET status = ?, resultJson = ?, errorJson = ? WHERE runId = ?"
            )
            .run(
              status,
              status === "Succeeded" ? canonical(payload) : null,
              terminal.has(status) && status !== "Succeeded"
                ? canonical(payload)
                : null,
              runId
            );
          event(runId, `status/${run.lastSequence + 1}`, "RunStatus", {
            status,
          });
          return getRun(runId);
        })()
      ),
    registerInvocation: (
      runId: string,
      nodeId: string,
      engineId: string,
      payload: Schema.Json
    ) =>
      perform(() =>
        database.transaction(() => {
          const prior = database
            .query(
              "SELECT engineId, payloadJson FROM host_invocations WHERE runId = ? AND nodeId = ?"
            )
            .get(runId, nodeId);
          if (prior) {
            const previous = Schema.decodeUnknownSync(
              Schema.Struct({
                engineId: Schema.String,
                payloadJson: Schema.String,
              })
            )(prior);
            if (
              previous.engineId !== engineId ||
              previous.payloadJson !== canonical(payload)
            ) {
              throw error("Conflict", "Task execution identity changed");
            }
            return;
          }
          const { count } = Schema.decodeUnknownSync(
            Schema.Struct({ count: Schema.Int })
          )(
            database
              .query(
                "SELECT COUNT(*) AS count FROM host_invocations WHERE runId = ?"
              )
              .get(runId)
          );
          if (count >= 10_000) {
            throw error("LimitExceeded", "Run invocation limit exceeded");
          }
          database
            .query("INSERT INTO host_invocations VALUES (?, ?, ?, ?)")
            .run(runId, nodeId, engineId, canonical(payload));
        })()
      ),
    scheduleError: scheduleCall("recordError"),
    scheduleGet: scheduleCall("describe"),
    scheduleHistory: scheduleCall("history"),
    scheduleIds: scheduleCall("ids"),
    scheduleList: scheduleCall("list"),
    scheduleMutation: scheduleCall("mutate"),
    scheduleReconcile: scheduleCall("reconcile"),
    scheduleTick: scheduleCall("tick"),
    schedulerStatus: scheduleCall("status"),
    setEngineId: (runId: string, engineId: string) =>
      perform(() => {
        const run = getRun(runId);
        if (run.engineId !== null && run.engineId !== engineId) {
          throw error("Conflict", "Engine execution identity is immutable");
        }
        database
          .query("UPDATE host_runs SET engineId = ? WHERE runId = ?")
          .run(engineId, runId);
      }),
    settle: (
      request: SettleWait,
      actor: string,
      validate: (input: Schema.Json) => Schema.Json
    ) =>
      perform(() => {
        const result = database.transaction(() => {
          const wait = getWait(request.waitId);
          authorizeRun(database, wait.runId, actor);
          checkJsonBudget(request.input ?? null);
          const fingerprint = canonical({
            input: request.input ?? null,
            operation: request.operation,
          });
          const prior = database
            .query(
              "SELECT * FROM host_receipts WHERE waitId = ? AND requestKey = ?"
            )
            .get(wait.waitId, request.requestKey);
          if (prior) {
            const receipt = Schema.decodeUnknownSync(
              Schema.Struct({
                actor: Schema.String,
                fingerprint: Schema.String,
                receiptJson: Schema.String,
              })
            )(prior);
            if (
              receipt.actor !== actor ||
              receipt.fingerprint !== fingerprint
            ) {
              throw error(
                "Conflict",
                "Request key was used for a different decision"
              );
            }
            return {
              receipt: Schema.decodeUnknownSync(WaitReceipt)(
                json(receipt.receiptJson)
              ),
            };
          }
          const expected = waitOperations[wait.kind];
          if (!expected.includes(request.operation)) {
            throw error("WrongWaitKind", "Operation does not match this wait");
          }
          if (wait.status !== "Open") {
            throw error("WaitClosed", `Wait is ${wait.status}`);
          }
          if (Date.now() >= wait.deadline) {
            closeWait(wait, "TimedOut", null);
            return { failure: error("WaitClosed", "Wait deadline elapsed") };
          }
          let payload: Schema.Json = null;
          if (
            request.operation === "respond" ||
            request.operation === "signal"
          ) {
            try {
              payload = validate(request.input ?? null);
            } catch {
              throw error(
                "InvalidInput",
                "Answer does not match the wait codec"
              );
            }
          }
          if (request.operation === "reject") {
            payload = request.input ?? null;
          }
          checkJsonBudget(payload);
          const outcomes = {
            approve: "Approved",
            reject: "Rejected",
            respond: "Responded",
            signal: "Signaled",
          } as const;
          const outcome = outcomes[request.operation];
          closeWait(wait, outcome, payload);
          const receipt: WaitReceipt = {
            actor,
            continuation: "Queued",
            outcome,
            requestKey: request.requestKey,
            runId: wait.runId,
            settledAt: new Date().toISOString(),
            waitId: wait.waitId,
          };
          database
            .query("INSERT INTO host_receipts VALUES (?, ?, ?, ?, ?)")
            .run(
              wait.waitId,
              request.requestKey,
              actor,
              fingerprint,
              canonical(receipt)
            );
          return { receipt };
        })();
        if (result.failure) {
          throw result.failure;
        }
        return result.receipt;
      }),
    get storageFailures() {
      return storageFailures;
    },
    submit: (request: Submit, resolvedRevision: string, principal: string) =>
      perform(() => submitRun(request, resolvedRevision, principal)),
    telemetry,
    get telemetryWriteFailures() {
      return telemetryWriteFailures;
    },
    waitPage: (request: typeof WaitListRequest.Type, principal: string) =>
      perform(() =>
        database.transaction(() =>
          waitPage(database, pagination, request, principal)
        )()
      ),
  };
}

export const HostStore = Context.Service<ReturnType<typeof createStore>>(
  "effectory/HostStore"
);

export function hostStoreLayer(filename: string) {
  return Layer.effect(
    HostStore,
    Effect.gen(function* () {
      const lease = yield* RepositoryLease;
      const database = yield* Effect.acquireRelease(
        Effect.sync(() => {
          lease.assertActive();
          return new Database(filename, { create: true });
        }),
        (db) => Effect.sync(() => db.close())
      );
      return createStore(database, lease);
    })
  );
}

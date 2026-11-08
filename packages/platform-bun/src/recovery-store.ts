import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { OperationError, terminal } from "@effectory/runtime/protocol";
import type { Run } from "@effectory/runtime/protocol";
import {
  RecoveryAssessment,
  RecoveryAssessmentRequest,
  RecoveryRequest,
  RecoveryReceipt,
} from "@effectory/runtime/recovery-protocol";
import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import { Schema } from "effect";

import type { Lease } from "./ownership.ts";
import type { createPagination } from "./pagination.ts";

interface AttemptRow {
  entries: number;
  startedAt: number;
  owner: string;
}
interface WindowRow {
  windowStartedAt: number;
  lastEnteredAt: number;
  timeout: number | null;
  deadline: number | null;
  taskVersion: number;
}
interface HoldRow {
  id: number;
  runId: string;
  nodeId: string;
  attempt: number;
  entry: number;
  observedAt: string;
  authorizationId: string | null;
  state: string;
}
export interface AttemptPolicy {
  readonly deadline?: number;
  readonly attemptTimeout?: number;
  readonly taskVersion?: number;
}
export interface Admission {
  readonly status: "Admitted" | "NeedsAttention" | "Cancelled" | "TimedOut";
  readonly entry: number;
  readonly windowStartedAt: number;
}
const fail = (code: OperationError["code"], message: string) =>
  new OperationError({ code, message });
const key = (runId: string, nodeId: string, attempt: number) =>
  canonical([runId, nodeId, attempt]);
const iso = (value: number) => new Date(value).toISOString();
const required = <A>(value: A | null): A => {
  if (value === null) {
    throw fail("Unavailable", "Recovery storage row is missing");
  }
  return value;
};
const fingerprint = (request: typeof RecoveryRequest.Type) =>
  canonical({ reason: request.reason ?? null, token: request.token });

/** All methods are synchronous and are called in the host's write transaction. */
export function createRecoveryStore(
  db: Database,
  lease: Lease,
  pagination: ReturnType<typeof createPagination>,
  getRun: (runId: string) => Run,
  event: (
    runId: string,
    eventKey: string,
    tag: string,
    payload: Schema.Json
  ) => void,
  project: (runId: string, status: Run["status"]) => void
) {
  db.run(`
    CREATE TABLE IF NOT EXISTS host_recovery_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1), sequence INTEGER NOT NULL);
    INSERT OR IGNORE INTO host_recovery_clock VALUES (1,0);
    CREATE TABLE IF NOT EXISTS host_attempt_windows (
      runId TEXT NOT NULL, nodeId TEXT NOT NULL, attempt INTEGER NOT NULL,
      windowStartedAt REAL NOT NULL, lastEnteredAt REAL NOT NULL, timeout REAL, deadline REAL, taskVersion INTEGER NOT NULL,
      PRIMARY KEY(runId,nodeId,attempt));
    CREATE TABLE IF NOT EXISTS host_recovery_holds (
      id INTEGER PRIMARY KEY, runId TEXT NOT NULL, nodeId TEXT NOT NULL, attempt INTEGER NOT NULL,
      entry INTEGER NOT NULL, observedAt TEXT NOT NULL, authorizationId TEXT, state TEXT NOT NULL,
      UNIQUE(runId,nodeId,attempt,entry));
    CREATE INDEX IF NOT EXISTS host_recovery_holds_run ON host_recovery_holds(runId,state,authorizationId);
    CREATE INDEX IF NOT EXISTS host_recovery_holds_invocation ON host_recovery_holds(runId,nodeId,state);
    CREATE TABLE IF NOT EXISTS host_recovery_gates (
      sequence INTEGER PRIMARY KEY, runId TEXT NOT NULL, nodeId TEXT NOT NULL, attempt INTEGER NOT NULL,
      UNIQUE(runId,nodeId,attempt));
    CREATE TABLE IF NOT EXISTS host_recovery_generations (
      id TEXT PRIMARY KEY, runId TEXT NOT NULL, acceptedSeq INTEGER NOT NULL, actor TEXT NOT NULL,
      requestKey TEXT NOT NULL, fingerprint TEXT NOT NULL, receiptJson TEXT NOT NULL,
      UNIQUE(runId,actor,requestKey));
    CREATE TABLE IF NOT EXISTS host_recovery_gate_obligations (
      generation TEXT NOT NULL, gateSeq INTEGER NOT NULL, runId TEXT NOT NULL, nodeId TEXT NOT NULL,
      attempt INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(generation,gateSeq));
    CREATE INDEX IF NOT EXISTS host_recovery_gate_work ON host_recovery_gate_obligations(runId,nodeId,closed);
  `);
  const live = new Map<string, number>();
  const incrementSequence = () =>
    required(
      db
        .query<{ sequence: number }, []>(
          "UPDATE host_recovery_clock SET sequence=sequence+1 RETURNING sequence"
        )
        .get()
    ).sequence;
  const held = (runId: string) =>
    db
      .query(
        "SELECT 1 FROM host_recovery_holds WHERE runId=? AND state='Open' AND authorizationId IS NULL LIMIT 1"
      )
      .get(runId) !== null;
  const fence = (runId: string) =>
    db.query("SELECT 1 FROM host_fences WHERE runId=?").get(runId) !== null;
  const clearGate = (runId: string, nodeId: string, attempt: number) => {
    db.query(`UPDATE host_recovery_gate_obligations SET closed=1 WHERE gateSeq IN
      (SELECT sequence FROM host_recovery_gates WHERE runId=? AND nodeId=? AND attempt=?)`).run(
      runId,
      nodeId,
      attempt
    );
    db.query(
      "DELETE FROM host_recovery_gates WHERE runId=? AND nodeId=? AND attempt=?"
    ).run(runId, nodeId, attempt);
  };
  const supersede = (runId: string, nodeId?: string) => {
    const clause = nodeId === undefined ? "runId=?" : "runId=? AND nodeId=?";
    const params = nodeId === undefined ? [runId] : [runId, nodeId];
    db.query(
      `UPDATE host_recovery_holds SET state='Superseded' WHERE ${clause} AND state='Open'`
    ).run(...params);
    db.query(
      `UPDATE host_recovery_gate_obligations SET closed=1 WHERE ${clause}`
    ).run(...params);
    db.query(`DELETE FROM host_recovery_gates WHERE ${clause}`).run(...params);
    if (
      !held(runId) &&
      getRun(runId).status === "NeedsAttention" &&
      !fence(runId)
    ) {
      project(runId, "Running");
    }
  };
  const window = (runId: string, nodeId: string, attempt: number) =>
    db
      .query<WindowRow, [string, string, number]>(
        "SELECT * FROM host_attempt_windows WHERE runId=? AND nodeId=? AND attempt=?"
      )
      .get(runId, nodeId, attempt);
  const timeout = (
    runId: string,
    nodeId: string,
    deadline: number
  ): Admission => {
    db.query(`INSERT INTO host_fences VALUES (?,?,?) ON CONFLICT(runId) DO UPDATE SET
      reasonJson=COALESCE(host_fences.reasonJson,excluded.reasonJson)`).run(
      runId,
      canonical({
        _tag: "ExecutionFailure",
        category: "Control",
        detail: { deadline, nodeId },
        outcome: "TimedOut",
      }),
      Date.now()
    );
    return { entry: 0, status: "TimedOut", windowStartedAt: 0 };
  };
  const recordUncertainty = (
    runId: string,
    nodeId: string,
    attempt: number,
    prior: AttemptRow,
    timing: WindowRow | null
  ): Admission => {
    const inserted = db
      .query(
        "INSERT OR IGNORE INTO host_recovery_holds VALUES (?,?,?,?,?,?,NULL,'Open')"
      )
      .run(
        incrementSequence(),
        runId,
        nodeId,
        attempt,
        prior.entries,
        iso(Date.now())
      );
    project(runId, "NeedsAttention");
    if (inserted.changes) {
      event(
        runId,
        `attention/${nodeId}/${attempt}/${prior.entries}`,
        "NeedsAttention",
        { attempt, entry: prior.entries, nodeId }
      );
    }
    return {
      entry: prior.entries,
      status: "NeedsAttention",
      windowStartedAt: timing?.windowStartedAt ?? prior.startedAt,
    };
  };
  // oxlint-disable-next-line complexity -- Ordered admission decisions must share one synchronous transaction.
  const admit = (
    runId: string,
    nodeId: string,
    attempt: number,
    replay: "manual" | "idempotent",
    policy: AttemptPolicy,
    reserve: boolean
  ): Admission => {
    lease.assertActive();
    clearGate(runId, nodeId, attempt);
    const run = getRun(runId);
    if (
      terminal.has(run.status) ||
      run.status === "Cancelling" ||
      fence(runId)
    ) {
      return { entry: 0, status: "Cancelled", windowStartedAt: 0 };
    }
    const now = Date.now();
    if (policy.deadline !== undefined && now >= policy.deadline) {
      return timeout(runId, nodeId, policy.deadline);
    }
    const prior = db
      .query<AttemptRow, [string, string, number]>(
        "SELECT entries,startedAt,owner FROM host_attempts WHERE runId=? AND nodeId=? AND activityAttempt=?"
      )
      .get(runId, nodeId, attempt);
    const previousWindow = window(runId, nodeId, attempt);
    // Never allow two in-process bodies to own the same attempt concurrently.
    if (live.has(key(runId, nodeId, attempt))) {
      if (prior && replay === "manual") {
        return recordUncertainty(runId, nodeId, attempt, prior, previousWindow);
      }
      db.query("INSERT INTO host_recovery_gates VALUES (?,?,?,?)").run(
        incrementSequence(),
        runId,
        nodeId,
        attempt
      );
      return {
        entry: prior?.entries ?? 0,
        status: "NeedsAttention",
        windowStartedAt: previousWindow?.windowStartedAt ?? now,
      };
    }
    let authorization: HoldRow | null = null;
    if (prior && replay === "manual") {
      authorization = db
        .query<
          HoldRow,
          [string, string, number, number]
        >(`SELECT * FROM host_recovery_holds
        WHERE runId=? AND nodeId=? AND attempt=? AND entry=? AND state='Open' AND authorizationId IS NOT NULL`)
        .get(runId, nodeId, attempt, prior.entries);
      if (!authorization) {
        return recordUncertainty(runId, nodeId, attempt, prior, previousWindow);
      }
    }
    const windowStartedAt =
      prior && replay === "idempotent"
        ? (previousWindow?.windowStartedAt ?? prior.startedAt)
        : now;
    const deadline = Math.min(
      policy.deadline ?? Number.POSITIVE_INFINITY,
      policy.attemptTimeout === undefined
        ? Number.POSITIVE_INFINITY
        : windowStartedAt + policy.attemptTimeout
    );
    if (now >= deadline) {
      return timeout(runId, nodeId, deadline);
    }
    if (!authorization && held(runId)) {
      db.query("INSERT INTO host_recovery_gates VALUES (?,?,?,?)").run(
        incrementSequence(),
        runId,
        nodeId,
        attempt
      );
      return {
        entry: prior?.entries ?? 0,
        status: "NeedsAttention",
        windowStartedAt,
      };
    }
    const entry = (prior?.entries ?? 0) + 1;
    db.query(`INSERT INTO host_attempts VALUES (?,?,?,?,1,?) ON CONFLICT(runId,nodeId,activityAttempt)
      DO UPDATE SET owner=excluded.owner,entries=entries+1`).run(
      runId,
      nodeId,
      attempt,
      lease.token,
      prior?.startedAt ?? now
    );
    db.query(`INSERT INTO host_attempt_windows VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(runId,nodeId,attempt)
      DO UPDATE SET windowStartedAt=excluded.windowStartedAt,lastEnteredAt=excluded.lastEnteredAt,
        timeout=excluded.timeout,deadline=excluded.deadline,taskVersion=excluded.taskVersion`).run(
      runId,
      nodeId,
      attempt,
      windowStartedAt,
      now,
      policy.attemptTimeout ?? null,
      policy.deadline ?? null,
      policy.taskVersion ?? 1
    );
    if (authorization) {
      db.query(
        "UPDATE host_recovery_holds SET state='Consumed' WHERE id=?"
      ).run(authorization.id);
    }
    event(
      runId,
      `attempt/${nodeId}/${attempt}${entry === 1 ? "" : `/${entry}`}`,
      "AttemptStarted",
      {
        attempt,
        deadline: Number.isFinite(deadline) ? deadline : null,
        entry,
        nodeId,
        startedAt: prior?.startedAt ?? now,
      }
    );
    if (reserve) {
      live.set(key(runId, nodeId, attempt), entry);
    }
    return { entry, status: "Admitted", windowStartedAt };
  };
  const pending = (runId: string) =>
    db
      .query(`SELECT 1 FROM host_recovery_holds WHERE runId=? AND state='Open' AND authorizationId IS NOT NULL
    UNION ALL SELECT 1 FROM host_recovery_gate_obligations WHERE runId=? AND closed=0 LIMIT 1`)
      .get(runId, runId) !== null;
  const authorizePrincipal = (runId: string, principal: string) => {
    const run = getRun(runId);
    if (
      db
        .query("SELECT 1 FROM host_runs WHERE runId=? AND principal=?")
        .get(runId, principal) === null
    ) {
      throw fail("NotFound", "Run was not found");
    }
    return run;
  };
  const holds = (runId: string) =>
    db
      .query<HoldRow, [string]>(
        "SELECT * FROM host_recovery_holds WHERE runId=? AND state='Open' AND authorizationId IS NULL ORDER BY id"
      )
      .all(runId);
  const generationCount = (runId: string) =>
    db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) count FROM host_recovery_generations WHERE runId=?"
      )
      .get(runId)?.count ?? 0;
  const countAuthorizations = (row: HoldRow) =>
    db
      .query<{ count: number }, [string, string, number]>(
        "SELECT COUNT(*) count FROM host_recovery_holds WHERE runId=? AND nodeId=? AND attempt=? AND authorizationId IS NOT NULL"
      )
      .get(row.runId, row.nodeId, row.attempt)?.count ?? 0;
  const setToken = (run: Run, rows: HoldRow[]) =>
    `rcv1.${createHash("sha256")
      .update(
        canonical({
          generations: generationCount(run.runId),
          holds: rows.map((row) => row.id),
          revision: run.revision,
          runId: run.runId,
          stopped: fence(run.runId),
          terminal: terminal.has(run.status),
        })
      )
      .digest("hex")}`;
  const stateOf = (
    run: Run,
    rows: HoldRow[],
    revisionAvailable: boolean
  ): typeof RecoveryAssessment.Type.state => {
    if (terminal.has(run.status)) {
      return "Terminal";
    }
    if (fence(run.runId) || run.status === "Cancelling") {
      return run.status === "NeedsAttention"
        ? "FinalizationStalled"
        : "Stopping";
    }
    if (!revisionAvailable) {
      return "RevisionUnavailable";
    }
    if (
      rows.some((row) => {
        const value = window(row.runId, row.nodeId, row.attempt)?.deadline;
        return value !== null && value !== undefined && value <= Date.now();
      })
    ) {
      return "DeadlineElapsed";
    }
    if (rows.some((row) => live.has(key(row.runId, row.nodeId, row.attempt)))) {
      return "ExecutionActive";
    }
    if (
      rows.length &&
      (generationCount(run.runId) >= 64 ||
        rows.some((row) => countAuthorizations(row) >= 16))
    ) {
      return "AuthorizationLimit";
    }
    if (pending(run.runId)) {
      return "Pending";
    }
    return rows.length ? "Recoverable" : "NotHeld";
  };
  const reasons: Record<typeof RecoveryAssessment.Type.state, string> = {
    AuthorizationLimit:
      "Recovery limit reached (16 per attempt or 64 per run); the whole set is refused. Cancel on the compatible host.",
    DeadlineElapsed: "An absolute run or ancestor deadline has elapsed.",
    ExecutionActive:
      "A previous target entry or its finalizers are still active.",
    FinalizationStalled:
      "Stopped execution or resource cleanup is unfinished; recovery cannot restart it.",
    NotHeld:
      "No uncertain manual entry is recorded. Leaves still restarting may add uncertainty later.",
    Pending:
      "Accepted recovery is still being delivered; inspect the latest authorization.",
    Recoverable:
      "All recorded uncertain entries can be authorized together; external actions may repeat.",
    RevisionUnavailable:
      "Pinned revision is unavailable; restore the compatible host build.",
    Stopping: "Run is stopping; recovery cannot clear its stop fence.",
    Terminal: "Run has finished and cannot be recovered.",
  };
  const assess = (
    value: typeof RecoveryAssessmentRequest.Type,
    principal: string,
    revisionAvailable: boolean
  ) => {
    const request = Schema.decodeSync(RecoveryAssessmentRequest)(value, {
      onExcessProperty: "error",
    });
    const run = authorizePrincipal(request.runId, principal);
    const rows = holds(run.runId);
    const token = setToken(run, rows);
    const scope = { kind: "recovery", principal, query: { runId: run.runId } };
    const cursor = pagination.read(scope, request.cursor);
    if (cursor && cursor.snapshot !== token) {
      throw fail("CursorExpired", "Recovery set changed; assess the run again");
    }
    const after = cursor
      ? Schema.decodeUnknownSync(Schema.Int)(cursor.position)
      : 0;
    const selected = rows
      .filter((row) => row.id > after)
      .slice(0, request.limit ?? 50);
    const entries = selected.map((row) => {
      const invocation = db
        .query<{ engineId: string; payloadJson: string }, [string, string]>(
          "SELECT engineId,payloadJson FROM host_invocations WHERE runId=? AND nodeId=?"
        )
        .get(run.runId, row.nodeId);
      if (!invocation) {
        throw fail("Unavailable", "Recovery invocation is missing");
      }
      const payload = Schema.decodeUnknownSync(
        Schema.Struct({ taskId: Schema.String })
      )(JSON.parse(invocation.payloadJson));
      const attempt = required(
        db
          .query<AttemptRow, [string, string, number]>(
            "SELECT entries,startedAt,owner FROM host_attempts WHERE runId=? AND nodeId=? AND activityAttempt=?"
          )
          .get(run.runId, row.nodeId, row.attempt)
      );
      const timing = window(run.runId, row.nodeId, row.attempt);
      const characters = [...row.nodeId];
      const hasLake = db
        .query("SELECT name FROM sqlite_master WHERE name='lake_records'")
        .get();
      const publications =
        hasLake === null
          ? 0
          : (db
              .query<
                { count: number },
                [string, string]
              >(`SELECT COUNT(*) count FROM lake_records
        WHERE json_extract(metadataJson,'$.runId')=? AND json_extract(metadataJson,'$.invocationPath')=?`)
              .get(run.runId, row.nodeId)?.count ?? 0);
      return {
        absoluteDeadline:
          timing?.deadline === null || timing?.deadline === undefined
            ? null
            : iso(timing.deadline),
        attempt: row.attempt,
        attemptTimeoutMillis: timing?.timeout ?? null,
        entry: row.entry,
        firstStartedAt: iso(attempt.startedAt),
        invocationId: invocation.engineId,
        lastEnteredAt: iso(timing?.lastEnteredAt ?? attempt.startedAt),
        observedAt: row.observedAt,
        pathPreview: characters.slice(0, 2048).join(""),
        pathTruncated: characters.length > 2048,
        priorAuthorizations: countAuthorizations(row),
        publicationCount: publications,
        taskId: payload.taskId,
        taskVersion: timing?.taskVersion ?? 1,
      };
    });
    const latest = db
      .query<{ id: string; receiptJson: string }, [string]>(
        "SELECT id,receiptJson FROM host_recovery_generations WHERE runId=? ORDER BY acceptedSeq DESC LIMIT 1"
      )
      .get(run.runId);
    const receipt = latest
      ? Schema.decodeUnknownSync(RecoveryReceipt)(
          JSON.parse(latest.receiptJson)
        )
      : null;
    const counts = latest
      ? db
          .query<{ state: string; count: number }, [string]>(
            "SELECT state,COUNT(*) count FROM host_recovery_holds WHERE authorizationId=? GROUP BY state"
          )
          .all(latest.id)
      : [];
    const count = (state: string) =>
      counts.find((row) => row.state === state)?.count ?? 0;
    const latestOpenGates = latest
      ? db
          .query(
            "SELECT 1 FROM host_recovery_gate_obligations WHERE generation=? AND closed=0 LIMIT 1"
          )
          .get(latest.id) !== null
      : false;
    const state = stateOf(run, rows, revisionAvailable);
    const last = selected.at(-1);
    return RecoveryAssessment.make({
      entries,
      latestAuthorization: receipt
        ? {
            acceptedAt: receipt.acceptedAt,
            actor: receipt.actor,
            authorizationId: receipt.authorizationId,
            authorized: receipt.authorized,
            consumedEntries: count("Consumed"),
            continuationPending: count("Open") > 0 || latestOpenGates,
            pendingEntries: count("Open"),
            requestKey: receipt.requestKey,
            supersededEntries: count("Superseded"),
          }
        : null,
      nextCursor:
        last && rows.some((row) => row.id > last.id)
          ? pagination.write(scope, token, last.id, Date.now() + 900_000)
          : null,
      reason: `${reasons[state]} Inspect: run recover ${run.runId}`,
      revision: run.revision,
      runId: run.runId,
      state,
      status: run.status,
      token: state === "Recoverable" ? token : null,
      total: rows.length,
    });
  };
  const lookup = (request: typeof RecoveryRequest.Type, principal: string) => {
    authorizePrincipal(request.runId, principal);
    const previous = db
      .query<
        { fingerprint: string; receiptJson: string },
        [string, string, string]
      >(
        "SELECT fingerprint,receiptJson FROM host_recovery_generations WHERE runId=? AND actor=? AND requestKey=?"
      )
      .get(request.runId, principal, request.requestKey);
    if (!previous) {
      return null;
    }
    if (previous.fingerprint !== fingerprint(request)) {
      throw fail(
        "Conflict",
        "Recovery request key was already accepted with a different token or reason"
      );
    }
    return Schema.decodeUnknownSync(RecoveryReceipt)(
      JSON.parse(previous.receiptJson)
    );
  };
  const recover = (
    value: typeof RecoveryRequest.Type,
    principal: string,
    revisionAvailable: boolean
  ) => {
    const request = Schema.decodeSync(RecoveryRequest)(value, {
      onExcessProperty: "error",
    });
    const previous = lookup(request, principal);
    if (previous) {
      return previous;
    }
    const run = getRun(request.runId);
    const rows = holds(run.runId);
    const state = stateOf(run, rows, revisionAvailable);
    if (state !== "Recoverable") {
      const codes: Partial<
        Record<typeof RecoveryAssessment.Type.state, OperationError["code"]>
      > = {
        AuthorizationLimit: "LimitExceeded",
        RevisionUnavailable: "RevisionUnavailable",
      };
      throw fail(
        codes[state] ?? "Conflict",
        `${reasons[state]} Inspect: run recover ${run.runId}`
      );
    }
    if (request.token !== setToken(run, rows)) {
      throw fail(
        "Conflict",
        `Recovery assessment changed; inspect run recover ${run.runId}`
      );
    }
    const id = crypto.randomUUID();
    const acceptedSeq = incrementSequence();
    const receipt = RecoveryReceipt.make({
      acceptedAt: iso(Date.now()),
      actor: principal,
      authorizationId: id,
      authorized: rows.length,
      outcome: "Accepted",
      reason: request.reason ?? null,
      requestKey: request.requestKey,
      runId: run.runId,
    });
    db.query(
      "INSERT INTO host_recovery_generations VALUES (?,?,?,?,?,?,?)"
    ).run(
      id,
      run.runId,
      acceptedSeq,
      principal,
      request.requestKey,
      fingerprint(request),
      JSON.stringify(receipt)
    );
    db.query(
      "UPDATE host_recovery_holds SET authorizationId=? WHERE runId=? AND state='Open' AND authorizationId IS NULL"
    ).run(id, run.runId);
    db.query(`INSERT INTO host_recovery_gate_obligations SELECT ?,sequence,runId,nodeId,attempt,0
      FROM host_recovery_gates WHERE runId=? AND sequence<?`).run(
      id,
      run.runId,
      acceptedSeq
    );
    project(run.runId, "Running");
    event(run.runId, `recovery/${id}`, "RecoveryAuthorized", {
      actor: principal,
      authorizationId: id,
      authorized: rows.length,
    });
    return receipt;
  };
  return {
    admit,
    assess,
    held,
    live: (runId: string, nodeId: string, attempt: number, entry: number) =>
      live.get(key(runId, nodeId, attempt)) === entry,
    lookup,
    recover,
    release: (
      runId: string,
      nodeId: string,
      attempt: number,
      entry: number
    ) => {
      const id = key(runId, nodeId, attempt);
      if (live.get(id) === entry) {
        live.delete(id);
      }
    },
    stopped: () => {
      const runs = db
        .query<
          { runId: string },
          []
        >(`SELECT DISTINCT h.runId FROM (SELECT runId FROM host_recovery_holds WHERE state='Open'
        UNION SELECT runId FROM host_recovery_gate_obligations WHERE closed=0) h JOIN host_runs r ON r.runId=h.runId
        WHERE r.status IN ('Succeeded','Failed','Cancelled','TimedOut','Rejected') OR EXISTS(SELECT 1 FROM host_fences f WHERE f.runId=h.runId)`)
        .all();
      for (const row of runs) {
        supersede(row.runId);
      }
    },
    supersede,
    work: (after: number) =>
      db
        .query<
          {
            position: number;
            runId: string;
            nodeId: string;
            engineId: string;
            needsResume: number;
          },
          [number]
        >(`
      SELECT i.rowid position,i.runId,i.nodeId,i.engineId,
        (EXISTS(SELECT 1 FROM host_recovery_holds h WHERE h.runId=i.runId AND h.nodeId=i.nodeId AND h.state='Open' AND h.authorizationId IS NOT NULL)
        OR EXISTS(SELECT 1 FROM host_recovery_gate_obligations g WHERE g.runId=i.runId AND g.nodeId=i.nodeId AND g.closed=0)) needsResume
      FROM host_invocations i WHERE i.rowid>? AND (
        EXISTS(SELECT 1 FROM host_recovery_holds h WHERE h.runId=i.runId AND h.nodeId=i.nodeId AND h.state='Open')
        OR EXISTS(SELECT 1 FROM host_recovery_gate_obligations g WHERE g.runId=i.runId AND g.nodeId=i.nodeId AND g.closed=0))
      ORDER BY i.rowid LIMIT 50`)
        .all(after),
  };
}

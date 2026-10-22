import type {
  ApprovalRecord,
  ArtifactRecord,
  RunRecord,
} from "@effectory/sdk/records";
import { Context, Effect } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { canonicalJson, digestJson, isTerminal } from "./store.ts";

export const EngineStore = Context.Service<SqlRuntimeStore>(
  "effectory/EngineStore"
);
export class SqlRuntimeStore {
  readonly sql: SqlClient.SqlClient;
  constructor(sql: SqlClient.SqlClient) {
    this.sql = sql;
  }
  private read<A>(table: string, id: string) {
    return this.sql
      .unsafe<{ data: string }>(`SELECT data FROM ${table} WHERE id=?`, [id])
      .pipe(
        Effect.map((rows) =>
          rows[0] ? (JSON.parse(rows[0].data) as A) : undefined
        ),
        Effect.orDie
      );
  }
  private all<A>(table: string) {
    return this.sql
      .unsafe<{ data: string }>(`SELECT data FROM ${table} ORDER BY rowid`)
      .pipe(
        Effect.map((rows) => rows.map((row) => JSON.parse(row.data) as A)),
        Effect.orDie
      );
  }
  getRun(id: string) {
    return this.read<RunRecord>("effectory_runs", id);
  }
  requireRun(id: string) {
    return this.getRun(id).pipe(
      Effect.map((run) => {
        if (!run) {
          throw new Error(`Unknown run: ${id}`);
        }
        return run;
      })
    );
  }
  listRuns() {
    return this.all<RunRecord>("effectory_runs");
  }
  putRun(run: RunRecord) {
    return this.sql
      .unsafe(
        "INSERT INTO effectory_runs(id,request_key,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        [run.id, run.requestKey, JSON.stringify(run)]
      )
      .pipe(Effect.as(run), Effect.orDie);
  }
  getArtifact(id: string) {
    return this.read<ArtifactRecord>("effectory_artifacts", id);
  }
  listArtifacts(runId?: string) {
    return this.all<ArtifactRecord>("effectory_artifacts").pipe(
      Effect.map((rows) => rows.filter((a) => !runId || a.runId === runId))
    );
  }
  getApproval(id: string) {
    return this.read<ApprovalRecord>("effectory_approvals", id);
  }
  requireApproval(id: string) {
    return this.getApproval(id).pipe(
      Effect.map((a) => {
        if (!a) {
          throw new Error(`Unknown approval: ${id}`);
        }
        return a;
      })
    );
  }
  listApprovals() {
    return this.all<ApprovalRecord>("effectory_approvals");
  }
  putApproval(a: ApprovalRecord) {
    return this.sql
      .unsafe(
        "INSERT INTO effectory_approvals(id,run_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        [a.id, a.runId, JSON.stringify(a)]
      )
      .pipe(Effect.as(a), Effect.orDie);
  }
  admit(run: RunRecord) {
    return this.sql
      .withTransaction(
        Effect.gen({ self: this }, function* admit() {
          const rows = yield* this.sql.unsafe<{ data: string }>(
            "SELECT data FROM effectory_runs WHERE request_key=?",
            [run.requestKey]
          );
          if (rows[0]) {
            const old = JSON.parse(rows[0].data) as RunRecord;
            if (
              old.task !== run.task ||
              old.revision !== run.revision ||
              canonicalJson(old.input) !== canonicalJson(run.input)
            ) {
              throw new Error(
                "Request key conflicts with accepted task, input or revision"
              );
            }
            return old;
          }
          return yield* this.putRun(run);
        })
      )
      .pipe(Effect.orDie);
  }
  publish(runId: string, name: string, value: unknown, schemaVersion = 1) {
    return this.sql
      .withTransaction(
        Effect.gen({ self: this }, function* publish() {
          if (
            !name ||
            !Number.isSafeInteger(schemaVersion) ||
            schemaVersion < 1
          ) {
            throw new Error("Invalid artifact metadata");
          }
          const id = digestJson([runId, name]);
          const digest = digestJson(value);
          const old = yield* this.getArtifact(id);
          if (old) {
            if (old.digest !== digest || old.schemaVersion !== schemaVersion) {
              throw new Error(`Artifact conflict: ${name}`);
            }
            return old;
          }
          const a: ArtifactRecord = {
            createdAt: new Date().toISOString(),
            digest,
            id,
            name,
            runId,
            schemaVersion,
            value,
          };
          yield* this.sql.unsafe(
            "INSERT INTO effectory_artifacts(id,run_id,data) VALUES (?,?,?)",
            [id, runId, JSON.stringify(a)]
          );
          return a;
        })
      )
      .pipe(Effect.orDie);
  }
  requestApproval(
    runId: string,
    options: { key: string; title: string; review: unknown },
    token: string
  ) {
    return this.sql
      .withTransaction(
        Effect.gen({ self: this }, function* requestApproval() {
          if (!options.key || !options.title) {
            throw new Error("Approval key and title are required");
          }
          const run = yield* this.requireRun(runId);
          if (run.status === "cancelling" || run.status === "cancelled") {
            return false;
          }
          const id = digestJson([run.id, options.key]);
          const digest = digestJson({
            input: run.input,
            review: options.review,
            revision: run.revision,
          });
          const old = yield* this.getApproval(id);
          if (old) {
            if (old.digest !== digest || old.title !== options.title) {
              throw new Error("Approval review changed during replay");
            }
            return true;
          }
          yield* this.putApproval({
            createdAt: new Date().toISOString(),
            delivered: false,
            digest,
            id,
            key: options.key,
            review: options.review,
            revision: run.revision,
            runId,
            status: "pending",
            title: options.title,
            token,
          });
          return true;
        })
      )
      .pipe(Effect.orDie);
  }
  cancel(id: string) {
    return this.sql
      .withTransaction(
        Effect.gen({ self: this }, function* cancel() {
          const run = yield* this.requireRun(id);
          if (isTerminal(run.status)) {
            return run;
          }
          yield* this.putRun({
            ...run,
            status: "cancelling",
            updatedAt: new Date().toISOString(),
          });
          for (const a of yield* this.listApprovals()) {
            if (a.runId === id && a.status !== "cancelled") {
              yield* this.putApproval({ ...a, status: "cancelled" });
            }
          }
          return yield* this.requireRun(id);
        })
      )
      .pipe(Effect.orDie);
  }
  resume(id: string) {
    return this.sql
      .withTransaction(
        Effect.gen({ self: this }, function* resume() {
          const run = yield* this.requireRun(id);
          if (isTerminal(run.status)) {
            return run;
          }
          const approvals = (yield* this.listApprovals()).filter(
            (a) => a.runId === id
          );
          const pending = approvals.find((a) => a.status === "pending");
          if (pending) {
            throw new Error(
              `Approve or reject approval ${pending.id} before resuming.`
            );
          }
          for (const approval of approvals) {
            if (approval.decision && !approval.released) {
              yield* this.putApproval({ ...approval, released: true });
            }
          }
          return run;
        })
      )
      .pipe(Effect.orDie);
  }
  decide(request: {
    id: string;
    digest: string;
    revision: string;
    outcome: "approved" | "rejected";
    reason?: string | undefined;
    operator?: string | undefined;
  }) {
    return this.sql
      .withTransaction(
        Effect.gen({ self: this }, function* decide() {
          const a = yield* this.requireApproval(request.id);
          if (a.digest !== request.digest || a.revision !== request.revision) {
            throw new Error("Stale approval digest or revision");
          }
          const run = yield* this.requireRun(a.runId);
          if (
            a.status === "cancelled" ||
            run.status === "cancelling" ||
            run.status === "cancelled"
          ) {
            throw new Error("Run is cancelled");
          }
          if (a.decision) {
            if (
              a.decision.outcome !== request.outcome ||
              a.decision.reason !== request.reason ||
              a.decision.operator !== (request.operator ?? "local-user")
            ) {
              throw new Error("Conflicting approval decision");
            }
            return a;
          }
          if (isTerminal(run.status)) {
            throw new Error("Run is already terminal");
          }
          if (request.outcome === "rejected") {
            yield* this.putRun({
              ...run,
              error: request.reason ?? "Approval rejected",
              status: "failed",
              updatedAt: new Date().toISOString(),
            });
          }
          return yield* this.putApproval({
            ...a,
            decision: {
              decidedAt: new Date().toISOString(),
              operator: request.operator ?? "local-user",
              outcome: request.outcome,
              ...(request.reason === undefined
                ? {}
                : { reason: request.reason }),
            },
            status: request.outcome,
          });
        })
      )
      .pipe(Effect.orDie);
  }
}

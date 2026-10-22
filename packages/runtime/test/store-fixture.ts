import { RuntimeStore } from "@effectory/runtime/store";
import type { ApprovalRecord, RunRecord } from "@effectory/sdk/records";

/** Mutate persisted records only to reproduce crash windows in recovery tests. */
export class TestStore extends RuntimeStore {
  requireRun(id: string): RunRecord {
    const row = this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM effectory_runs WHERE id=?"
      )
      .get(id);
    if (!row) {
      throw new Error(`Unknown run: ${id}`);
    }
    return JSON.parse(row.data) as RunRecord;
  }
  putRun(run: RunRecord) {
    this.db
      .query(
        "INSERT INTO effectory_runs(id,request_key,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data"
      )
      .run(run.id, run.requestKey, JSON.stringify(run));
  }
  putApproval(approval: ApprovalRecord) {
    this.db
      .query(
        "INSERT INTO effectory_approvals(id,run_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data"
      )
      .run(approval.id, approval.runId, JSON.stringify(approval));
  }
}

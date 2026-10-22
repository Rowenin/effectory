export type RunStatus =
  | "admitted"
  | "running"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "cancelling";
export interface RunRecord {
  id: string;
  task: string;
  revision: string;
  requestKey: string;
  input: unknown;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  /** Success schema JSON wire value, including null for native Void. */
  result?: unknown;
  /** Inspection failure, never an invented workflow failure. Unreadable replies retry on reopen. */
  inspectionError?: string;
  error?: unknown;
}
export interface ArtifactRecord {
  id: string;
  runId: string;
  name: string;
  schemaVersion: number;
  digest: string;
  value: unknown;
  createdAt: string;
}
export interface ApprovalDecision {
  outcome: "approved" | "rejected";
  reason?: string | undefined;
  operator: string;
  decidedAt: string;
}
export interface ApprovalRecord {
  id: string;
  runId: string;
  key: string;
  title: string;
  review: unknown;
  digest: string;
  revision: string;
  token: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  createdAt: string;
  decision?: ApprovalDecision;
  delivered: boolean;
  /** An explicit resume authorized delivery of this decision. */
  released?: boolean;
}

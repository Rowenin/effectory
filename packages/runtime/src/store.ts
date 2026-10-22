import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";

import type { RunStatus, RunRecord } from "@effectory/sdk/records";

import { prepareDatabase } from "./database.ts";
import { workspacePaths } from "./paths.ts";

export const MAX_JSON_BYTES = 256 * 1024;
export const canonicalJson = (value: unknown): string => {
  const visit = (v: unknown): unknown => {
    if (v === null || typeof v === "string" || typeof v === "boolean") {
      return v;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      return v;
    }
    if (Array.isArray(v)) {
      return v.map(visit);
    }
    if (
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.keys(v)
          .toSorted()
          .map((key) => [key, visit((v as Record<string, unknown>)[key])])
      );
    }
    throw new Error("Expected finite JSON data");
  };
  const json = JSON.stringify(visit(value));
  if (Buffer.byteLength(json) > MAX_JSON_BYTES) {
    throw new Error(`JSON exceeds ${MAX_JSON_BYTES} bytes`);
  }
  return json;
};
export const digestJson = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export const isTerminal = (status: RunStatus) =>
  ["succeeded", "failed", "cancelled"].includes(status);

export class RuntimeStore {
  readonly db: Database;
  readonly filename: string;
  constructor(workspace: string) {
    const paths = workspacePaths(workspace);
    mkdirSync(paths.state, { recursive: true });
    this.filename = prepareDatabase(workspace);
    this.db = new Database(this.filename, { create: true });
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS effectory_owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, nonce TEXT NOT NULL, identity TEXT);
      CREATE TABLE IF NOT EXISTS effectory_runs (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS effectory_artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS effectory_approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL);`);
    const columns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(effectory_owner)")
      .all();
    if (!columns.some((column) => column.name === "identity")) {
      this.db.exec("ALTER TABLE effectory_owner ADD COLUMN identity TEXT");
    }
  }
  transaction<A>(body: () => A): A {
    return this.db.transaction(body).immediate();
  }
  listRuns(): RunRecord[] {
    return this.db
      .query<{ data: string }, []>(
        "SELECT data FROM effectory_runs ORDER BY rowid"
      )
      .all()
      .map((row) => JSON.parse(row.data) as RunRecord);
  }
  close() {
    this.db.close();
  }
}

// The sync connection above is used only for schema setup, ownership, and revision preflight.
// Live application operations use the very same SqlClient as the workflow journal.

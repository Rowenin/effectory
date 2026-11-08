import type { Database } from "bun:sqlite";

import type { Expression } from "@effectory/runtime/lake-protocol";
import type { Field } from "@offtree/effectory-sdk/internal/artifact-query-schema";

/** Keep index expressions identical to the corresponding candidate predicates. */
export function initializeQueryIndexes(database: Database) {
  database
    .transaction(() => {
      const installed =
        database
          .query(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lake_query_tags'"
          )
          .get() !== null;
      database.run(`
    CREATE INDEX IF NOT EXISTS lake_query_identity ON lake_records(principal, schemaId, schemaVersion, artifactId, sequence) WHERE reclaimedAt IS NULL;
    CREATE INDEX IF NOT EXISTS lake_query_run ON lake_records(principal, schemaId, schemaVersion, json_extract(metadataJson, '$.runId'), sequence) WHERE reclaimedAt IS NULL;
    CREATE INDEX IF NOT EXISTS lake_query_task ON lake_records(principal, schemaId, schemaVersion, json_extract(metadataJson, '$.taskId'), sequence) WHERE reclaimedAt IS NULL;
    CREATE TABLE IF NOT EXISTS lake_query_tags (
      sequence INTEGER NOT NULL REFERENCES lake_records(sequence) ON DELETE CASCADE,
      name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(sequence, name)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS lake_query_tag_value ON lake_query_tags(name, value, sequence);
    CREATE TRIGGER IF NOT EXISTS lake_query_tags_insert AFTER INSERT ON lake_records BEGIN
      INSERT INTO lake_query_tags(sequence, name, value)
      SELECT NEW.sequence, entry.key, entry.value FROM json_each(NEW.metadataJson, '$.tags') entry
      WHERE NEW.reclaimedAt IS NULL AND entry.type = 'text';
    END;
    CREATE TRIGGER IF NOT EXISTS lake_query_tags_update AFTER UPDATE OF metadataJson, reclaimedAt ON lake_records BEGIN
      DELETE FROM lake_query_tags WHERE sequence = NEW.sequence;
      INSERT INTO lake_query_tags(sequence, name, value)
      SELECT NEW.sequence, entry.key, entry.value FROM json_each(NEW.metadataJson, '$.tags') entry
      WHERE NEW.reclaimedAt IS NULL AND entry.type = 'text';
    END;
  `);
      if (!installed) {
        database.run(`INSERT INTO lake_query_tags(sequence, name, value)
        SELECT r.sequence, entry.key, entry.value FROM lake_records r, json_each(r.metadataJson, '$.tags') entry
        WHERE r.reclaimedAt IS NULL AND entry.type = 'text'`);
      }
    })
    .immediate();
}

type MetadataField = Extract<Field, { readonly metadata: unknown }>["metadata"];

/** Metadata equalities with a matching candidate index. */
const metadataClauses: ReadonlyMap<MetadataField, string> = new Map([
  ["artifactId", "r.artifactId = ?"],
  ["runId", "json_extract(r.metadataJson, '$.runId') = ?"],
  ["taskId", "json_extract(r.metadataJson, '$.taskId') = ?"],
]);

/**
 * Only necessary equalities may narrow the candidate set. The full predicate
 * still runs in the existing evaluator, and latest-version selection must see
 * every newer version, including versions that do not satisfy these equalities.
 */
export function queryCandidates(expression: Expression | undefined) {
  const clauses: string[] = [];
  const values: string[] = [];
  const tags: string[] = [];
  const tagValues: string[] = [];
  const pending = expression === undefined ? [] : [expression];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      break;
    }
    if (node._tag === "And") {
      pending.push(...node.terms);
      continue;
    }
    // Do not descend into Or or Not: their child equalities are not required.
    // Keep ill-formed UTF-16 on the JS path rather than allowing SQLite/Bun's
    // UTF-8 conversion to change equality. NUL also stays on that path.
    if (
      node._tag !== "Eq" ||
      typeof node.value !== "string" ||
      !node.value.isWellFormed() ||
      node.value.includes("\0")
    ) {
      continue;
    }
    if ("metadata" in node.field) {
      const clause = metadataClauses.get(node.field.metadata);
      if (clause !== undefined) {
        clauses.push(clause);
        values.push(node.value);
      }
    } else if (
      "tag" in node.field &&
      /^[a-zA-Z0-9._/-]+$/u.test(node.field.tag)
    ) {
      // Literal keys (including dots/slashes), never interpolated JSON paths.
      tags.push(
        "SELECT sequence FROM lake_query_tags WHERE name = ? AND value = ?"
      );
      tagValues.push(node.field.tag, node.value);
    }
  }
  if (tags.length > 0) {
    clauses.push(`r.sequence IN (${tags.join(" INTERSECT ")})`);
    values.push(...tagValues);
  }
  return {
    clause: clauses.length === 0 ? "" : `AND ${clauses.join(" AND ")}`,
    values,
  };
}

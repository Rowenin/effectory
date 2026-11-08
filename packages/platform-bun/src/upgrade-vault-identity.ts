import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { Cause, Effect, Exit, Schema } from "effect";

import { unsupportedUpgradeWork, upgradeScanner } from "./upgrade-scan.ts";

// Only this predecessor schema is understood. In particular, do not silently
// ignore an added column, trigger, table, or SQLite statistics/shadow table.
const columns = {
  sqlite_sequence: ["name", "seq"],
  vault_identities: ["id", "key_id", "state", "check_mac"],
  vault_meta: ["singleton", "counter", "absence"],
  vault_receipts: [
    "serial",
    "vault",
    "key",
    "request_key",
    "mac",
    "version",
    "operation",
  ],
  vault_values: ["vault", "key", "version", "value"],
} as const;
const isTable = (name: string): name is keyof typeof columns =>
  Object.hasOwn(columns, name);
const names = Object.keys(columns).filter(isTable);
const indexes = new Set([
  "sqlite_autoindex_vault_identities_1",
  "sqlite_autoindex_vault_receipts_1",
  "sqlite_autoindex_vault_values_1",
  "vault_tombstones",
]);
const CatalogRow = Schema.Struct({
  name: Schema.String,
  sql: Schema.NullOr(Schema.String),
  tbl_name: Schema.String,
  type: Schema.String,
});
const Row = Schema.Struct({ encoded: Schema.String, position: Schema.Int });

/**
 * Compare vault contents across an owned user_version fence, using a recovered
 * PRIVATE database. It deliberately excludes user_version and physical page/WAL
 * layout, but includes schema, counters, ciphertext, tombstones and receipts.
 * No decryption, external key access, or author code. Unknown schemas refuse.
 */
export function inspectUpgradeVaultIdentity(database: Database) {
  return Effect.gen(function* () {
    const hash = createHash("sha256");
    const add = (text: string) => {
      hash.update(`${Buffer.byteLength(text)}:`);
      hash.update(text);
    };
    yield* Effect.try({
      catch: () => unsupportedUpgradeWork("vault identity schema"),
      try: () => {
        const sizes = database.prepare<{ bytes: number }, []>(
          "SELECT octet_length(type)+octet_length(name)+octet_length(tbl_name)+COALESCE(octet_length(sql),0) bytes FROM sqlite_master LIMIT 33"
        );
        try {
          const measured = sizes.all();
          if (
            measured.length > 32 ||
            measured.some(
              (row) =>
                !Number.isSafeInteger(row.bytes) ||
                row.bytes < 0 ||
                row.bytes > 65_536
            )
          ) {
            throw new Error("Unsupported vault schema size");
          }
        } finally {
          sizes.finalize();
        }
        const statement = database.prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name LIMIT 33"
        );
        let rows;
        try {
          rows = statement.all();
        } finally {
          statement.finalize();
        }
        if (rows.length > 32) {
          throw new Error("Too many schema objects");
        }
        const tables = new Set<string>();
        for (const raw of rows) {
          const decoded = Schema.decodeUnknownExit(CatalogRow)(raw);
          if (Exit.isFailure(decoded)) {
            throw Cause.squash(decoded.cause);
          }
          const row = decoded.value;
          if (Buffer.byteLength(JSON.stringify(row)) > 65_536) {
            throw new Error("Oversized schema");
          }
          if (row.type === "table" && isTable(row.name)) {
            tables.add(row.name);
          } else if (
            row.type !== "index" ||
            !indexes.has(row.name) ||
            !isTable(row.tbl_name)
          ) {
            throw new Error("Unknown schema object");
          }
          add(JSON.stringify(row));
        }
        if (tables.size !== names.length) {
          throw new Error("Missing vault table");
        }
        for (const table of names) {
          const info = database.prepare<{ name: string }, []>(
            `PRAGMA table_xinfo("${table}")`
          );
          let fields;
          try {
            fields = info.all();
          } finally {
            info.finalize();
          }
          if (
            JSON.stringify(fields.map((field) => field.name)) !==
            JSON.stringify(columns[table])
          ) {
            throw new Error("Unknown vault columns");
          }
        }
      },
    });
    const scanner = upgradeScanner(database);
    for (const table of names) {
      add(table);
      // Encode storage class plus exact bytes in SQLite, before JS sees values.
      // TEXT may contain NUL; quote() would truncate it. INTEGER conversion in
      // SQLite avoids JS rounding. Real values are not part of this schema.
      const fields = columns[table].map(
        (name) => `typeof("${name}"),hex(CAST("${name}" AS BLOB))`
      );
      const supported = columns[table]
        .map((name) => `typeof("${name}") IN ('null','integer','text','blob')`)
        .join(" AND ");
      yield* scanner.scan(
        "vault identity contents",
        `SELECT rowid position,CASE WHEN ${supported} THEN json_array(${fields.join(",")}) ELSE NULL END encoded FROM "${table}" WHERE /* after */ ORDER BY rowid LIMIT ?`,
        (raw) => {
          const row = Schema.decodeUnknownSync(Row)(raw);
          add(JSON.stringify(row));
        },
        "rowid"
      );
    }
    return { ...scanner.totals, digest: hash.digest("hex") };
  });
}

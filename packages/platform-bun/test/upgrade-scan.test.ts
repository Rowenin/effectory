import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { Effect, Fiber } from "effect";

import { upgradeScanner } from "../src/upgrade-scan.ts";

test("dense inspection pages shrink before JavaScript materialization and still visit every row once", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE journal(id INTEGER PRIMARY KEY,payload TEXT)");
  const payload = "😀".repeat(131_072);
  db.transaction(() => {
    for (let id = 1; id <= 25; id += 1) {
      db.query("INSERT INTO journal VALUES(?,?)").run(id, payload);
    }
  })();
  try {
    const seen: number[] = [];
    const scanner = upgradeScanner(db);
    await Effect.runPromise(
      scanner.scan(
        "fixture",
        "SELECT id position,payload FROM journal WHERE /* after */ ORDER BY id LIMIT ?",
        (raw) => {
          const row = raw as { position: number; payload: string };
          expect(row.payload).toBe(payload);
          seen.push(row.position);
        }
      )
    );
    expect(seen).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    expect(scanner.totals.rows).toBe(25);
    expect(scanner.totals.bytes).toBeGreaterThan(12_000_000);
    expect(db.inTransaction).toBe(false);
  } finally {
    db.close();
  }
});

test("an oversized journal row refuses before the visitor and releases the transaction", async () => {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE journal(id INTEGER PRIMARY KEY,payload BLOB); INSERT INTO journal VALUES(1,zeroblob(8388609))"
  );
  try {
    let visited = false;
    const scanner = upgradeScanner(db);
    const failure = await Effect.runPromise(
      scanner
        .scan(
          "fixture",
          "SELECT id position,payload FROM journal WHERE /* after */ ORDER BY id LIMIT ?",
          () => {
            visited = true;
          }
        )
        .pipe(Effect.flip)
    );
    expect(failure.code).toBe("LimitExceeded");
    expect(visited).toBe(false);
    expect(scanner.totals.rows).toBe(0);
    expect(db.inTransaction).toBe(false);
    db.exec("BEGIN EXCLUSIVE; ROLLBACK");
  } finally {
    db.close();
  }
});

test("interruption between bounded pages leaves no live read cursor or transaction", async () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE journal(id INTEGER PRIMARY KEY);
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO journal SELECT x FROM n`);
  try {
    let visited = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* upgradeScanner(db)
          .scan(
            "fixture",
            "SELECT id position FROM journal WHERE /* after */ ORDER BY id LIMIT ?",
            () => {
              visited += 1;
            }
          )
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
      })
    );
    expect(visited).toBeGreaterThan(0);
    expect(visited).toBeLessThan(10_000);
    expect(db.inTransaction).toBe(false);
    db.exec("BEGIN EXCLUSIVE; ROLLBACK");
  } finally {
    db.close();
  }
});

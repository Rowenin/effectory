import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { VaultStore } from "../src/vault-store.ts";

const previous = process.env.EFFECTORY_KEY_DIR;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).toReversed()) {
    f();
  }
  if (previous === undefined) {
    delete process.env.EFFECTORY_KEY_DIR;
  } else {
    process.env.EFFECTORY_KEY_DIR = previous;
  }
});
function fixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), "effectory-vault-"));
  const repository = path.join(base, "repo");
  mkdirSync(path.join(repository, ".effectory"), { recursive: true });
  process.env.EFFECTORY_KEY_DIR = path.join(base, "keys");
  const store = new VaultStore(repository, {
    assertActive() {},
    token: "test",
  });
  cleanup.push(
    () => rmSync(base, { force: true, recursive: true }),
    () => store.close()
  );
  return { base, repository, store };
}
const put = (
  store: VaultStore,
  key: string,
  version: string,
  value = "CANARY-stored-token-12345678",
  vault = "credentials",
  requestKey: string = crypto.randomUUID()
) =>
  store.mutate({
    expectedVersion: version,
    key,
    operation: "Put",
    requestKey,
    value,
    vault,
  });

test("ciphertext and receipts contain no plaintext; exact retries and stale writes", () => {
  const { store, repository } = fixture();
  expect(readdirSync(path.join(repository, ".effectory"))).toEqual([]);
  store.init("credentials");
  const receipt = put(
    store,
    "token",
    "0",
    "CANARY-stored-token-12345678",
    "credentials",
    "request"
  );
  expect(receipt.version).toBe("1");
  expect(store.reveal("credentials", "token")).toBe(
    "CANARY-stored-token-12345678"
  );
  put(store, "token", "1", "rotated-token-12345678");
  const retry = put(
    store,
    "token",
    "0",
    "CANARY-stored-token-12345678",
    "credentials",
    "request"
  );
  expect(retry).toMatchObject({
    current: { _tag: "Present", version: "2" },
    replayed: true,
    version: "1",
  });
  expect(() =>
    put(store, "token", "0", "different-value", "credentials", "request")
  ).toThrow("reused");
  expect(() => put(store, "token", "1")).toThrow("current Present:2");
  store.checkpoint();
  expect(
    readFileSync(path.join(repository, ".effectory/vaults.sqlite")).includes(
      Buffer.from("CANARY-stored-token-12345678")
    )
  ).toBe(false);
});

test("reset fences stale requests across vaults but keeps existing key versions valid", () => {
  const { store } = fixture();
  store.init("credentials");
  store.init("other");
  put(store, "a", "0");
  put(store, "b", "0", "other-token-12345678", "other");
  store.reset("other");
  expect(store.state("credentials", "new")).toEqual({
    _tag: "Absent",
    version: "3",
  });
  expect(() => put(store, "new", "0")).toThrow("current Absent:3");
  expect(put(store, "a", "1").version).toBe("4");
  expect(() => store.reset("missing")).toThrow("not found");
  expect(store.state("credentials", "new")).toEqual({
    _tag: "Absent",
    version: "3",
  });
});

test("capacity pruning checks CAS before advancing absence; receipts are bounded", () => {
  const { store, repository } = fixture();
  store.init("credentials");
  for (let n = 0; n < 256; n += 1) {
    put(store, `k${n}`, "0");
  }
  store.mutate({
    expectedVersion: "1",
    key: "k0",
    operation: "Delete",
    requestKey: "delete",
    vault: "credentials",
  });
  const added = put(store, "new", "0");
  expect(added.version).toBe("259");
  expect(store.state("credentials", "k0")).toEqual({
    _tag: "Absent",
    version: "258",
  });
  let version = "259";
  for (let n = 0; n < 12; n += 1) {
    ({ version } = put(store, "new", version));
  }
  const db = new Database(path.join(repository, ".effectory/vaults.sqlite"));
  expect(
    db
      .query<{ n: number }, []>(
        "SELECT count(*) n FROM vault_receipts WHERE key='new'"
      )
      .get()?.n
  ).toBe(8);
  expect(
    db
      .query<{ n: number }, []>(
        "SELECT count(*) n FROM vault_receipts WHERE key='k0'"
      )
      .get()?.n
  ).toBe(0);
  db.close();
});

test("missing keys never regenerate; export/import restore, reset uses fresh key identity", () => {
  const { store, base } = fixture();
  const initial = store.init("credentials");
  put(store, "token", "0");
  const exported = path.join(base, "recovery.json");
  store.exportKey("credentials", exported);
  rmSync(path.join(base, "keys"), { recursive: true });
  expect(store.status("credentials").state).toBe("KeyMissing");
  expect(() => store.init("credentials")).toThrow("already initialized");
  store.importKey("credentials", exported);
  expect(store.reveal("credentials", "token")).toBe(
    "CANARY-stored-token-12345678"
  );
  store.reset("credentials");
  expect(store.init("credentials").keyId).not.toBe(initial.keyId);
});

test("corruption fails an operation, key destinations cannot enter repository", () => {
  const { store, repository, base } = fixture();
  process.env.EFFECTORY_KEY_DIR = path.join(repository, "keys");
  expect(() => store.init("credentials")).toThrow("outside the repository");
  process.env.EFFECTORY_KEY_DIR = path.join(base, "keys");
  store.init("credentials");
  expect(() =>
    store.exportKey("credentials", path.join(repository, "key.json"))
  ).toThrow("outside the repository");
  store.close();
  writeFileSync(
    path.join(repository, ".effectory/vaults.sqlite"),
    "not a database"
  );
  const other = new VaultStore(repository, { assertActive() {}, token: "x" });
  expect(() => other.list()).toThrow();
  other.close();
});

test("Pending init recovers a matching file and replaces an absent identity safely", () => {
  const { store, repository } = fixture();
  store.list();
  const db = new Database(path.join(repository, ".effectory/vaults.sqlite"));
  const abandoned = crypto.randomUUID();
  db.query("INSERT INTO vault_identities VALUES(?,?,'Pending',NULL)").run(
    "credentials",
    abandoned
  );
  const ready = store.init("credentials");
  expect(ready.keyId).not.toBe(abandoned);
  db.query(
    "UPDATE vault_identities SET state='Pending',check_mac=NULL WHERE id='credentials'"
  ).run();
  expect(store.init("credentials").keyId).toBe(ready.keyId);
  expect(store.state("credentials", "fresh")).toEqual({
    _tag: "Absent",
    version: "0",
  });
  db.close();
});

test("quota rejects writes atomically, and deletion/reset free capacity", () => {
  const { store } = fixture();
  store.init("credentials");
  store.init("other");
  const value = "x".repeat(65_536);
  let first = "";
  for (let n = 0; n < 255; n += 1) {
    const receipt = put(store, `large${n}`, "0", value);
    if (n === 0) {
      first = receipt.version;
    }
  }
  expect(() => put(store, "overflow", "0", value, "other")).toThrow(
    "ciphertext limit"
  );
  expect(store.state("other", "overflow")).toEqual({
    _tag: "Absent",
    version: "0",
  });
  store.mutate({
    expectedVersion: first,
    key: "large0",
    operation: "Delete",
    requestKey: "free-space",
    vault: "credentials",
  });
  expect(put(store, "overflow", "0", value, "other").replayed).toBe(false);
  store.reset("credentials");
  expect(store.usage().ciphertextBytes).toBeLessThan(66_000);
});

test("physical page cap still permits deletion and reset, and corruption is value-free", () => {
  const { store, repository } = fixture();
  store.init("credentials");
  const row = put(store, "large", "0", "CANARY-large-secret-".repeat(3000));
  // Fault injection on the actual store connection, never a production escape hatch.
  const db: unknown = Reflect.get(store, "database");
  if (!(db instanceof Database)) {
    throw new TypeError("Expected the store database connection");
  }
  const pages = db
    .query<{ page_count: number }, []>("PRAGMA page_count")
    .get()?.page_count;
  expect(pages).toBeDefined();
  db.run(`PRAGMA max_page_count=${pages}`);
  expect(() => put(store, "more", "0", "y".repeat(65_536))).toThrow();
  store.mutate({
    expectedVersion: row.version,
    key: "large",
    operation: "Delete",
    requestKey: "delete-at-cap",
    vault: "credentials",
  });
  store.reset("credentials");
  expect(store.usage().ciphertextBytes).toBe(0);
  store.checkpoint();
  expect(
    readFileSync(path.join(repository, ".effectory/vaults.sqlite")).includes(
      Buffer.from("CANARY-large-secret-")
    )
  ).toBe(false);
});

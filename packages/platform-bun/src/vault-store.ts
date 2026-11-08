import { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Vault } from "@offtree/effectory-sdk";
import { builtinBackends } from "@offtree/effectory-sdk/internal/vault-state";
import { Effect, Option, Redacted } from "effect";

import type { Lease } from "./ownership.ts";
import { readRuntimeStorage } from "./runtime-storage-format.ts";
import { isEmptyUpgradeVault } from "./upgrade-vault-fence.ts";

const failure = (code: (typeof OperationError.Type)["code"], message: string) =>
  new OperationError({ code, message });
function required<A>(value: A | null | undefined): A {
  if (value === null || value === undefined) {
    throw failure("Unavailable", "Vault Corrupt: required state unavailable");
  }
  return value;
}

const mapped = (error: unknown) =>
  error instanceof OperationError
    ? error
    : failure(
        error instanceof Error &&
          (Reflect.get(error, "code") === "SQLITE_FULL" ||
            Reflect.get(error, "code") === "ENOSPC" ||
            error.message.includes("database or disk is full"))
          ? "StorageFull"
          : "Unavailable",
        "Local vault storage is unavailable; check doctor, key availability and disk space"
      );
const name = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u.test(value)) {
    throw failure("InvalidInput", "Invalid vault or key name");
  }
  return value;
};
const resolved = (filename: string): string =>
  existsSync(filename)
    ? realpathSync(filename)
    : path.join(resolved(path.dirname(filename)), path.basename(filename));
export function outsideRepository(repository: string, filename: string) {
  const target = resolved(path.resolve(filename));
  const relative = path.relative(realpathSync(repository), target);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  ) {
    throw failure(
      "InvalidInput",
      "Vault keys and explicit secret output files must be outside the repository"
    );
  }
  return target;
}
export function keyDirectory(repository: string) {
  return outsideRepository(
    repository,
    process.env.EFFECTORY_KEY_DIR ??
      path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
        "effectory",
        "keys"
      )
  );
}
function durableExclusive(filename: string, bytes: Uint8Array) {
  const fd = openSync(filename, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(path.dirname(filename), "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
interface Identity {
  id: string;
  key_id: string;
  state: "Pending" | "Ready";
  check_mac: string | null;
}
interface SecretRow {
  vault: string;
  key: string;
  version: number;
  value: Uint8Array | null;
}
interface ReceiptRow {
  mac: string;
  version: number;
  operation: "Put" | "Delete";
}
export interface Mutation {
  readonly vault: string;
  readonly key: string;
  readonly requestKey: string;
  readonly expectedVersion: string;
  readonly operation: "Put" | "Delete";
  readonly value?: string;
}
export interface Receipt {
  readonly vault: string;
  readonly key: string;
  readonly operation: "Put" | "Delete";
  readonly version: string;
  readonly replayed: boolean;
  readonly current: Vault.KeyState;
}
const derive = (root: Buffer, purpose: string) =>
  Buffer.from(hkdfSync("sha256", root, "effectory-vault-v1", purpose, 32));
const mac = (root: Buffer, data: string) =>
  createHmac("sha256", derive(root, "receipts")).update(data).digest("hex");
function equal(a: string, b: string) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
function keyFile(filename: string, keyId: string): Buffer {
  if (!existsSync(filename)) {
    throw failure(
      "Unavailable",
      "Vault KeyMissing; import the matching recovery key, never reinitialize"
    );
  }
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) {
    throw failure("Unavailable", "Vault KeyMismatch: invalid key file");
  }
  const data: unknown = JSON.parse(readFileSync(filename, "utf-8"));
  if (
    !data ||
    typeof data !== "object" ||
    Reflect.get(data, "keyId") !== keyId ||
    Reflect.get(data, "format") !== 1
  ) {
    throw failure("Unavailable", "Vault KeyMismatch: wrong key identity");
  }
  const encoded = Reflect.get(data, "key");
  if (typeof encoded !== "string" || !/^[a-f0-9]{64}$/u.test(encoded)) {
    throw failure("Unavailable", "Vault KeyMismatch: invalid key material");
  }
  return Buffer.from(encoded, "hex");
}
function encrypt(
  root: Buffer,
  vault: string,
  key: string,
  version: number,
  value: string
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    derive(root, "encryption"),
    nonce
  );
  cipher.setAAD(Buffer.from(JSON.stringify([1, vault, key, String(version)])));
  const body = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}
function decrypt(root: Buffer, row: SecretRow) {
  if (!row.value || row.value.byteLength < 28) {
    throw failure("Unavailable", "Vault Corrupt: invalid encrypted value");
  }
  try {
    const bytes = Buffer.from(row.value);
    const cipher = createDecipheriv(
      "aes-256-gcm",
      derive(root, "encryption"),
      bytes.subarray(0, 12)
    );
    cipher.setAAD(
      Buffer.from(JSON.stringify([1, row.vault, row.key, String(row.version)]))
    );
    cipher.setAuthTag(bytes.subarray(12, 28));
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()])
    );
  } catch {
    throw failure(
      "Unavailable",
      "Vault Corrupt: encrypted value authentication failed"
    );
  }
}

/** One per daemon, lazy DB acquisition; no application code executes in transactions. */
export class VaultStore {
  private database: Database | undefined;
  private closed = false;
  readonly backends = new WeakSet<Vault.Backend>();
  readonly repository: string;
  private readonly lease: Lease;
  constructor(repository: string, lease: Lease) {
    this.repository = repository;
    this.lease = lease;
  }
  private db(): Database {
    this.lease.assertActive();
    if (this.closed) {
      throw failure("Unavailable", "Vault Closed");
    }
    if (this.database) {
      return this.database;
    }
    const storage = readRuntimeStorage(this.repository);
    const filename = path.join(this.repository, ".effectory/vaults.sqlite");
    if (storage !== null && !existsSync(filename)) {
      throw failure(
        "RevisionUnavailable",
        "Upgraded vault storage is missing; preserve the repository and its recovery copy"
      );
    }
    if (
      existsSync(filename) &&
      (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink())
    ) {
      throw failure("Unavailable", "Vault Corrupt: invalid database file");
    }
    const db = new Database(filename, { create: true });
    try {
      chmodSync(filename, 0o600);
      const version = db
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()?.user_version;
      if (storage === null ? version !== 0 && version !== 1 : version !== 2) {
        throw failure(
          "Unavailable",
          "Vault Corrupt: unsupported database version"
        );
      }
      let emptyFence = false;
      if (storage !== null) {
        const sentinel = db.prepare(
          "SELECT 1 FROM sqlite_master WHERE name='effectory_upgrade_empty'"
        );
        try {
          if (sentinel.get() !== null) {
            emptyFence = isEmptyUpgradeVault(db, {
              planId: storage.planId,
              targetBuild: storage.targetBuild,
            });
            if (!emptyFence) {
              throw failure(
                "RevisionUnavailable",
                "Upgraded vault sentinel is damaged; preserve the repository"
              );
            }
          }
        } finally {
          sentinel.finalize();
        }
      }
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=OFF; PRAGMA journal_size_limit=1048576; PRAGMA busy_timeout=0;"
      );
      const pageSize = required(
        db.query<{ page_size: number }, []>("PRAGMA page_size").get()
      ).page_size;
      db.exec(`PRAGMA max_page_count=${Math.floor(67_108_864 / pageSize)}`);
      db.transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS vault_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), counter INTEGER NOT NULL, absence INTEGER NOT NULL);
        INSERT OR IGNORE INTO vault_meta VALUES(1,0,0);
        CREATE TABLE IF NOT EXISTS vault_identities (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, state TEXT NOT NULL, check_mac TEXT);
        CREATE TABLE IF NOT EXISTS vault_values (vault TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, value BLOB, PRIMARY KEY(vault,key));
        CREATE TABLE IF NOT EXISTS vault_receipts (serial INTEGER PRIMARY KEY AUTOINCREMENT, vault TEXT NOT NULL, key TEXT NOT NULL, request_key TEXT NOT NULL, mac TEXT NOT NULL, version INTEGER NOT NULL, operation TEXT NOT NULL, UNIQUE(vault,key,request_key));
        CREATE INDEX IF NOT EXISTS vault_tombstones ON vault_values(vault,version) WHERE value IS NULL;
        PRAGMA user_version=${storage === null ? 1 : 2};`);
        if (emptyFence) {
          db.exec("DROP TABLE effectory_upgrade_empty");
        }
      }).immediate();
      this.database = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  private transaction<A>(action: () => A): A {
    return this.db().transaction(action).immediate();
  }
  private identity(vault: string) {
    return this.db()
      .query<Identity, [string]>("SELECT * FROM vault_identities WHERE id=?")
      .get(name(vault));
  }
  private row(vault: string, key: string) {
    return this.db()
      .query<SecretRow, [string, string]>(
        "SELECT * FROM vault_values WHERE vault=? AND key=?"
      )
      .get(vault, key);
  }
  private root(vault: string) {
    const identity = this.identity(vault);
    if (!identity || identity.state === "Pending") {
      throw failure(
        "Unavailable",
        `Vault ${vault} NotInitialized; run vault init`
      );
    }
    const root = keyFile(
      path.join(keyDirectory(this.repository), `${identity.key_id}.json`),
      identity.key_id
    );
    if (
      !identity.check_mac ||
      !equal(
        identity.check_mac,
        mac(root, `identity/${identity.key_id}/${vault}`)
      )
    ) {
      throw failure(
        "Unavailable",
        `Vault ${vault} KeyMismatch; import the matching key`
      );
    }
    return root;
  }
  private next() {
    const { counter } = required(
      this.db()
        .query<{ counter: number }, []>(
          "SELECT counter FROM vault_meta WHERE singleton=1"
        )
        .get()
    );
    if (counter >= Number.MAX_SAFE_INTEGER - 1) {
      throw failure("LimitExceeded", "Vault version counter exhausted");
    }
    this.db()
      .query("UPDATE vault_meta SET counter=? WHERE singleton=1")
      .run(counter + 1);
    return counter + 1;
  }
  private fence() {
    const value = this.next();
    this.db()
      .query("UPDATE vault_meta SET absence=? WHERE singleton=1")
      .run(value);
  }
  state(vault: string, key: string): Vault.KeyState {
    name(vault);
    name(key);
    const row = this.row(vault, key);
    return row
      ? {
          _tag: row.value === null ? "Deleted" : "Present",
          version: String(row.version),
        }
      : {
          _tag: "Absent",
          version: String(
            required(
              this.db()
                .query<{ absence: number }, []>(
                  "SELECT absence FROM vault_meta WHERE singleton=1"
                )
                .get()
            ).absence
          ),
        };
  }
  status(vault: string) {
    const identity = this.identity(vault);
    if (!identity || identity.state === "Pending") {
      return {
        hint: identity ? "init interrupted; rerun init" : "run vault init",
        keyId: identity?.key_id ?? null,
        state: "NotInitialized" as const,
      };
    }
    try {
      this.root(vault);
      return { hint: null, keyId: identity.key_id, state: "Ready" as const };
    } catch (error) {
      return {
        hint: "import the matching recovery key",
        keyId: identity.key_id,
        state:
          error instanceof OperationError &&
          error.message.includes("KeyMissing")
            ? ("KeyMissing" as const)
            : ("KeyMismatch" as const),
      };
    }
  }
  list() {
    return this.db()
      .query<{ id: string }, []>("SELECT id FROM vault_identities ORDER BY id")
      .all()
      .map((r) => r.id);
  }
  keys(vault: string) {
    return this.db()
      .query<{ key: string }, [string]>(
        "SELECT key FROM vault_values WHERE vault=? ORDER BY key"
      )
      .all(name(vault))
      .map((r) => r.key);
  }
  usage() {
    return {
      ciphertextBytes: required(
        this.db()
          .query<{ n: number }, []>(
            "SELECT coalesce(sum(length(value)),0) AS n FROM vault_values"
          )
          .get()
      ).n,
      ciphertextLimit: 16_777_216,
      receiptLimit: 4096,
      receipts: required(
        this.db()
          .query<{ n: number }, []>("SELECT count(*) AS n FROM vault_receipts")
          .get()
      ).n,
      vaultLimit: 128,
      vaults: this.list().length,
    };
  }
  init(vault: string) {
    name(vault);
    const directory = keyDirectory(this.repository);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    let identity = this.identity(vault);
    if (identity?.state === "Ready") {
      throw failure("Conflict", `Vault ${vault} is already initialized`);
    }
    let filename = identity
      ? path.join(directory, `${identity.key_id}.json`)
      : "";
    if (!identity || !existsSync(filename)) {
      this.transaction(() => {
        if (!identity && this.list().length >= 128) {
          throw failure(
            "LimitExceeded",
            "Vault identity limit reached; use vault reset for unused local vaults"
          );
        }
        identity = {
          check_mac: null,
          id: vault,
          key_id: crypto.randomUUID(),
          state: "Pending",
        };
        this.db()
          .query(
            "INSERT INTO vault_identities(id,key_id,state,check_mac) VALUES(?,?,'Pending',NULL) ON CONFLICT(id) DO UPDATE SET key_id=excluded.key_id,state='Pending',check_mac=NULL"
          )
          .run(vault, identity.key_id);
      });
      filename = path.join(directory, `${required(identity).key_id}.json`);
      durableExclusive(
        filename,
        Buffer.from(
          JSON.stringify({
            format: 1,
            key: randomBytes(32).toString("hex"),
            keyId: required(identity).key_id,
          })
        )
      );
    }
    const selected = required(identity);
    const root = keyFile(filename, selected.key_id);
    this.transaction(() => {
      if (this.keys(vault).length) {
        throw failure(
          "Unavailable",
          `Vault ${vault} Corrupt: Pending identity has values`
        );
      }
      this.db()
        .query(
          "UPDATE vault_identities SET state='Ready',check_mac=? WHERE id=? AND key_id=?"
        )
        .run(
          mac(root, `identity/${selected.key_id}/${vault}`),
          vault,
          selected.key_id
        );
    });
    return this.status(vault);
  }
  reveal(vault: string, key: string) {
    name(key);
    const root = this.root(vault);
    const row = this.row(vault, key);
    if (!row?.value) {
      throw failure("NotFound", `Vault ${vault}/${key} not found`);
    }
    return decrypt(root, row);
  }
  lookup(request: Mutation): Receipt | undefined {
    const root = this.root(request.vault);
    const row = this.db()
      .query<ReceiptRow, [string, string, string]>(
        "SELECT mac,version,operation FROM vault_receipts WHERE vault=? AND key=? AND request_key=?"
      )
      .get(request.vault, request.key, request.requestKey);
    if (!row) {
      return undefined;
    }
    if (
      !equal(
        row.mac,
        mac(
          root,
          JSON.stringify([
            request.operation,
            request.vault,
            request.key,
            request.expectedVersion,
            request.value ?? null,
          ])
        )
      )
    ) {
      throw failure(
        "Conflict",
        `Vault ${request.vault}/${request.key} request key reused with different payload`
      );
    }
    return {
      current: this.state(request.vault, request.key),
      key: request.key,
      operation: row.operation,
      replayed: true,
      vault: request.vault,
      version: String(row.version),
    };
  }
  mutate(request: Mutation): Receipt {
    name(request.vault);
    name(request.key);
    if (
      !/^(?:0|[1-9][0-9]{0,15})$/u.test(request.expectedVersion) ||
      !request.requestKey ||
      request.requestKey.length > 200
    ) {
      throw failure(
        "InvalidInput",
        "Invalid vault version token or request key"
      );
    }
    if (
      request.operation === "Put" &&
      (typeof request.value !== "string" ||
        Buffer.byteLength(request.value) > 65_536 ||
        Buffer.from(request.value).toString("utf-8") !== request.value)
    ) {
      throw failure(
        "InvalidInput",
        "Vault value must be valid UTF-8 and at most 64 KiB"
      );
    }
    const root = this.root(request.vault);
    let pruned = false;
    const receipt = this.transaction(() => {
      const prior = this.lookup(request);
      if (prior) {
        return prior;
      }
      const current = this.state(request.vault, request.key);
      if (
        current._tag === "Unknown" ||
        current.version !== request.expectedVersion
      ) {
        throw failure(
          "Conflict",
          `Vault ${request.vault}/${request.key}: expected ${request.expectedVersion}, current ${current._tag}${current._tag === "Unknown" ? "" : `:${current.version}`}; describe again`
        );
      }
      if (request.operation === "Delete" && current._tag !== "Present") {
        throw failure(
          "NotFound",
          `Vault ${request.vault}/${request.key} not found`
        );
      }
      if (
        request.operation === "Put" &&
        current._tag === "Absent" &&
        this.keys(request.vault).length >= 256
      ) {
        const tombstone = this.db()
          .query<{ key: string }, [string, string]>(
            "SELECT key FROM vault_values WHERE vault=? AND key<>? AND value IS NULL ORDER BY version LIMIT 1"
          )
          .get(request.vault, request.key);
        if (!tombstone) {
          throw failure(
            "LimitExceeded",
            `Vault ${request.vault} has 256 stored keys; delete unused values first`
          );
        }
        this.db()
          .query("DELETE FROM vault_values WHERE vault=? AND key=?")
          .run(request.vault, tombstone.key);
        this.db()
          .query("DELETE FROM vault_receipts WHERE vault=? AND key=?")
          .run(request.vault, tombstone.key);
        this.fence();
        pruned = true;
      }
      const version = this.next();
      const value =
        request.operation === "Put"
          ? encrypt(
              root,
              request.vault,
              request.key,
              version,
              required(request.value)
            )
          : null;
      const old = this.row(request.vault, request.key)?.value?.byteLength ?? 0;
      if (
        value &&
        this.usage().ciphertextBytes - old + value.byteLength > 16_777_216
      ) {
        throw failure(
          "LimitExceeded",
          "Vault ciphertext limit reached; describe, delete unused keys or reset an unused vault"
        );
      }
      this.db()
        .query(
          "INSERT INTO vault_values(vault,key,version,value) VALUES(?,?,?,?) ON CONFLICT(vault,key) DO UPDATE SET version=excluded.version,value=excluded.value"
        )
        .run(request.vault, request.key, version, value);
      this.db()
        .query(
          "DELETE FROM vault_receipts WHERE serial IN (SELECT serial FROM vault_receipts WHERE vault=? AND key=? ORDER BY serial DESC LIMIT -1 OFFSET 7)"
        )
        .run(request.vault, request.key);
      this.db()
        .query(
          "DELETE FROM vault_receipts WHERE serial IN (SELECT serial FROM vault_receipts ORDER BY serial DESC LIMIT -1 OFFSET 4095)"
        )
        .run();
      this.db()
        .query(
          "INSERT INTO vault_receipts(vault,key,request_key,mac,version,operation) VALUES(?,?,?,?,?,?)"
        )
        .run(
          request.vault,
          request.key,
          request.requestKey,
          mac(
            root,
            JSON.stringify([
              request.operation,
              request.vault,
              request.key,
              request.expectedVersion,
              request.value ?? null,
            ])
          ),
          version,
          request.operation
        );
      return {
        current: this.state(request.vault, request.key),
        key: request.key,
        operation: request.operation,
        replayed: false,
        vault: request.vault,
        version: String(version),
      };
    });
    if (pruned) {
      this.checkpoint();
    }
    return receipt;
  }
  reset(vault: string) {
    this.transaction(() => {
      if (!this.identity(vault)) {
        throw failure("NotFound", `Vault ${vault} not found`);
      }
      this.db().query("DELETE FROM vault_values WHERE vault=?").run(vault);
      this.db().query("DELETE FROM vault_receipts WHERE vault=?").run(vault);
      this.db().query("DELETE FROM vault_identities WHERE id=?").run(vault);
      this.fence();
    });
    this.checkpoint();
    return { discarded: true, vault };
  }
  exportKey(vault: string, output: string) {
    const target = outsideRepository(this.repository, output);
    this.root(vault);
    const identity = required(this.identity(vault));
    const bytes = readFileSync(
      path.join(keyDirectory(this.repository), `${identity.key_id}.json`)
    );
    durableExclusive(target, bytes);
    return { keyId: identity.key_id, output: target, vault };
  }
  importKey(vault: string, input: string) {
    const identity = this.identity(vault);
    if (!identity || identity.state !== "Ready" || !identity.check_mac) {
      throw failure(
        "NotFound",
        `Vault ${vault} has no initialized key identity`
      );
    }
    const root = keyFile(input, identity.key_id);
    if (
      !equal(
        identity.check_mac,
        mac(root, `identity/${identity.key_id}/${vault}`)
      )
    ) {
      throw failure("Conflict", `Vault ${vault} KeyMismatch`);
    }
    const directory = keyDirectory(this.repository);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    const filename = path.join(directory, `${identity.key_id}.json`);
    if (existsSync(filename)) {
      const installed = keyFile(filename, identity.key_id);
      if (!timingSafeEqual(installed, root)) {
        throw failure("Conflict", `Vault ${vault} already has another key`);
      }
    } else {
      durableExclusive(
        filename,
        Buffer.from(
          JSON.stringify({
            format: 1,
            key: root.toString("hex"),
            keyId: identity.key_id,
          })
        )
      );
    }
    return { imported: true, keyId: identity.key_id, vault };
  }
  readonly service: typeof Vault.LocalStore.Service = {
    open: (spec) =>
      Effect.sync(() => {
        const attempt = <A>(
          action: () => A
        ): Effect.Effect<A, Vault.VaultUnavailable | Vault.VaultFailure> =>
          Effect.try({
            catch: (error) => {
              const detail = mapped(error);
              if (detail.message.includes("NotInitialized")) {
                return new Vault.VaultUnavailable({
                  reason: "NotInitialized",
                  vault: spec.id,
                });
              }
              if (detail.message.includes("KeyMissing")) {
                return new Vault.VaultUnavailable({
                  reason: "KeyMissing",
                  vault: spec.id,
                });
              }
              let reason: "Closed" | "KeyMismatch" | "Corrupt" = "Corrupt";
              if (this.closed) {
                reason = "Closed";
              } else if (detail.message.includes("KeyMismatch")) {
                reason = "KeyMismatch";
              }
              return new Vault.VaultFailure({
                reason,
                vault: spec.id,
              });
            },
            try: action,
          });
        const backend: Vault.Backend = {
          inspect: (key) => attempt(() => this.state(spec.id, key)),
          list: attempt(() => this.keys(spec.id)),
          providerId: "effectory/local",
          read: (key) =>
            attempt(() => {
              const root = this.root(spec.id);
              const row = this.row(spec.id, key);
              return row?.value
                ? Option.some(Redacted.make(decrypt(root, row)))
                : Option.none();
            }),
        };
        builtinBackends.add(backend);
        this.backends.add(backend);
        return backend;
      }),
  };
  checkpoint() {
    this.database?.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close() {
    try {
      this.checkpoint();
    } finally {
      this.closed = true;
      this.database?.close();
      this.database = undefined;
    }
  }
}
export const vaultOperation = <A>(action: () => A) =>
  Effect.try({ catch: mapped, try: action });
export const makeVaultStore = (repository: string, lease: Lease) =>
  Effect.acquireRelease(
    Effect.sync(() => new VaultStore(repository, lease)),
    (store) => vaultOperation(() => store.close()).pipe(Effect.orDie)
  );

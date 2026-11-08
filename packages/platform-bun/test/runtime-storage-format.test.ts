import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";

import {
  readLock,
  replaceFile,
  lockFilename,
} from "../src/extension-bindings.ts";
import {
  encodeStoredLock,
  readRuntimeStorage,
  readStoredCredentials,
} from "../src/runtime-storage-format.ts";
import { fileFence } from "../src/upgrade-file-fence.ts";
import { makeUpgradeJournal } from "../src/upgrade-journal.ts";
import { publishRuntimeStorage } from "../src/upgrade-publication.ts";
import { vaultFence } from "../src/upgrade-vault-fence.ts";
import { fenceFixture } from "./fixtures/upgrade-fence-fixture.ts";

const complete = (f: ReturnType<typeof fenceFixture>, original: boolean) =>
  f.run(
    Effect.gen(function* () {
      const journal = yield* makeUpgradeJournal(f.repository);
      yield* fileFence(f.repository, "Credentials", f.owner, "Protect");
      yield* vaultFence(f.repository, f.owner, "Protect", original);
      yield* fileFence(f.repository, "Extensions", f.owner, "Protect");
      for (const name of f.plan.migrations.slice(0, 3)) {
        yield* journal.checkpoint(
          f.owner.planId,
          f.owner.targetBuild,
          { completedStep: name },
          3
        );
      }
      yield* journal.checkpoint(
        f.owner.planId,
        f.owner.targetBuild,
        { phase: "Fenced" },
        3
      );
      yield* journal.checkpoint(
        f.owner.planId,
        f.owner.targetBuild,
        { phase: "Migrating" },
        4
      );
      const publishing = yield* journal.checkpoint(
        f.owner.planId,
        f.owner.targetBuild,
        { phase: "Publishing" },
        5
      );
      yield* publishRuntimeStorage(f.repository, publishing);
      expect(() => readStoredCredentials(f.repository)).toThrow("unfinished");
      yield* journal.checkpoint(
        f.owner.planId,
        f.owner.targetBuild,
        { completedStep: "runtime-storage-v2" },
        6
      );
      yield* journal.checkpoint(
        f.owner.planId,
        f.owner.targetBuild,
        { phase: "Complete" },
        6
      );
      return yield* journal.release(f.owner.planId, f.owner.targetBuild);
    })
  );

test("normal reads require completed matching receipts and normal writes preserve every downgrade fence", async () => {
  const f = fenceFixture();
  try {
    f.seed();
    await f.accept();
    await complete(f, true);
    expect(readStoredCredentials(f.repository)).toEqual({
      repositoryId: "fixture",
      token: "CANARY-fence-fixture",
    });
    expect(readRuntimeStorage(f.repository)?.format).toBe(2);
    const lock = { format: 1 as const, packages: {}, roots: {} };
    expect(readLock(f.repository)).toEqual(lock);
    replaceFile(
      lockFilename(f.repository),
      encodeStoredLock(f.repository, JSON.stringify(lock))
    );
    expect(
      JSON.parse(readFileSync(lockFilename(f.repository), "utf-8"))
    ).toMatchObject({ format: 2, planId: f.owner.planId });
    expect(readLock(f.repository)).toEqual(lock);
    const store = f.vault();
    try {
      expect(store.reveal("credentials", "token")).toBe("CANARY-fence-fixture");
      store.mutate({
        expectedVersion: "1",
        key: "token",
        operation: "Put",
        requestKey: "rotation",
        value: "CANARY-rotated",
        vault: "credentials",
      });
    } finally {
      store.close();
    }
    const database = new Database(path.join(f.state, "vaults.sqlite"), {
      readonly: true,
    });
    try {
      expect(
        database
          .query<{ user_version: number }, []>("PRAGMA user_version")
          .get()?.user_version
      ).toBe(2);
    } finally {
      database.close();
    }
    const reopened = f.vault();
    try {
      expect(reopened.reveal("credentials", "token")).toBe("CANARY-rotated");
    } finally {
      reopened.close();
    }
    writeFileSync(path.join(f.state, "credentials.json"), f.credentials);
    expect(() => readStoredCredentials(f.repository)).toThrow(
      "completed matching upgrade receipt"
    );
  } finally {
    f.cleanup();
  }
});

test("an upgraded empty vault initializes once without dropping its format fence", async () => {
  const f = fenceFixture();
  try {
    await f.accept();
    await complete(f, false);
    f.seed();
    const store = f.vault();
    try {
      expect(store.reveal("credentials", "token")).toBe("CANARY-fence-fixture");
    } finally {
      store.close();
    }
    const database = new Database(path.join(f.state, "vaults.sqlite"), {
      readonly: true,
    });
    try {
      expect(
        database
          .query<{ user_version: number }, []>("PRAGMA user_version")
          .get()?.user_version
      ).toBe(2);
      expect(
        database
          .query(
            "SELECT name FROM sqlite_master WHERE name='effectory_upgrade_empty'"
          )
          .get()
      ).toBeNull();
    } finally {
      database.close();
    }
  } finally {
    f.cleanup();
  }
});

test("foreign and unfinished receipt metadata never enables normal storage", async () => {
  const f = fenceFixture();
  try {
    await f.accept();
    await complete(f, false);
    const filename = path.join(f.state, "runtime-storage.json");
    const value = JSON.parse(readFileSync(filename, "utf-8"));
    writeFileSync(
      filename,
      JSON.stringify({ ...value, targetBuild: "c".repeat(64) })
    );
    expect(() => readStoredCredentials(f.repository)).toThrow(
      "completed matching upgrade receipt"
    );
    const before = readFileSync(path.join(f.state, "vaults.sqlite"));
    const store = f.vault();
    try {
      expect(() => store.init("credentials")).toThrow(
        "completed matching upgrade receipt"
      );
    } finally {
      store.close();
    }
    expect(readFileSync(path.join(f.state, "vaults.sqlite"))).toEqual(before);
  } finally {
    f.cleanup();
  }
});

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Exit, Schema } from "effect";

import {
  readRuntimeStorage,
  readStoredCredentials,
  readStoredLockContents,
} from "../src/runtime-storage-format.ts";
import { assessRuntimeUpgrade } from "../src/upgrade-assessment.ts";
import { acceptRuntimeUpgrade } from "../src/upgrade-executor.ts";
import { format2Fixture } from "./fixtures/upgrade-format2-fixture.ts";

const readCredentials = (filename: string) =>
  Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Struct({ planId: Schema.String, targetBuild: Schema.String })
    )
  )(readFileSync(filename, "utf-8"));

const bytes = (root: string, file: string) =>
  readFileSync(path.join(root, file), "utf-8");
const ownedFiles = [
  ".effectory/credentials.json",
  "effectory.extensions.lock.json",
  ".effectory/runtime-storage.json",
];

test.each([false, true])(
  "format-2 transition preserves prior receipts and vault contents (real vault: %s)",
  async (realVault) => {
    const f = await format2Fixture(realVault);
    try {
      const previous = bytes(
        f.repository,
        `.effectory/upgrade-history/${f.plan.planId}.json`
      );
      expect(f.saved.plan.status).toBe("Ready");
      expect(f.saved.plan.source.storage).toBe(2);
      const result = await f.run(
        acceptRuntimeUpgrade(f.repository, f.saved, f.policy)
      );
      expect(result.phase).toBe("Complete");
      expect(readRuntimeStorage(f.repository)?.format).toBe(3);
      expect(readRuntimeStorage(f.repository)?.targetBuild).toBe(
        f.nextOwner.targetBuild
      );
      expect(readStoredCredentials(f.repository).token).toBe(
        "CANARY-fence-fixture"
      );
      expect(readStoredLockContents(f.repository)).toBeNull();
      expect(
        bytes(f.repository, `.effectory/upgrade-history/${f.plan.planId}.json`)
      ).toBe(previous);
      const db = new Database(path.join(f.state, "vaults.sqlite"), {
        readonly: true,
      });
      try {
        expect(db.query("PRAGMA user_version").get()).toEqual({
          user_version: 2,
        });
        if (!realVault) {
          expect(
            db.query("SELECT * FROM effectory_upgrade_empty").get()
          ).toEqual(f.nextOwner);
        }
      } finally {
        db.close();
      }
      const vault = f.vault();
      try {
        if (realVault) {
          expect(vault.reveal("credentials", "token")).toBe(
            "CANARY-fence-fixture"
          );
        } else {
          vault.init("new");
          expect(vault.status("new").state).toBe("Ready");
        }
      } finally {
        vault.close();
      }
      rmSync(f.saved.plan.recoveryCopy, { force: true, recursive: true });
      expect(await f.resume()).toEqual(result);
    } finally {
      f.cleanup();
    }
  }
);

test.each([false, true])(
  "format-2 abort restores the previous owners without reverting unrelated edits (real vault: %s)",
  async (realVault) => {
    const f = await format2Fixture(realVault);
    try {
      const original = ownedFiles.map((file) => bytes(f.repository, file));
      expect(Exit.isFailure(await f.accept("extension-lock-v2"))).toBe(true);
      writeFileSync(path.join(f.repository, "operator-edit"), "preserve me");
      const result = await f.resume();
      expect(result.phase).toBe("Aborted");
      expect(ownedFiles.map((file) => bytes(f.repository, file))).toEqual(
        original
      );
      expect(bytes(f.repository, "operator-edit")).toBe("preserve me");
      expect(readRuntimeStorage(f.repository)?.targetBuild).toBe(
        f.owner.targetBuild
      );
      if (!realVault) {
        const db = new Database(path.join(f.state, "vaults.sqlite"), {
          readonly: true,
        });
        try {
          expect(
            db.query("SELECT * FROM effectory_upgrade_empty").get()
          ).toEqual(f.owner);
        } finally {
          db.close();
        }
      }
      expect(await f.resume()).toEqual(result);
    } finally {
      f.cleanup();
    }
  }
);

test("format-2 abort keeps a changed logical credential and rejects a foreign owner", async () => {
  const f = await format2Fixture(false);
  try {
    await f.accept("credentials-envelope-v2");
    const filename = path.join(f.state, "credentials.json");
    const current = Schema.decodeSync(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
    )(readFileSync(filename, "utf-8"));
    writeFileSync(
      filename,
      JSON.stringify({ ...current, targetBuild: "d".repeat(64) })
    );
    const refused = await f.resume().then(
      () => false,
      () => true
    );
    expect(refused).toBe(true);
    expect(readCredentials(filename).targetBuild).toBe("d".repeat(64));
    writeFileSync(
      filename,
      JSON.stringify({
        ...current,
        contents: JSON.stringify({
          repositoryId: "fixture",
          token: "changed-token",
        }),
      })
    );
    const aborted = await f.resume();
    expect(aborted.phase).toBe("Aborted");
    expect(readStoredCredentials(f.repository).token).toBe("changed-token");
    expect(readCredentials(filename).planId).toBe(f.owner.planId);
  } finally {
    f.cleanup();
  }
});

test("format-2 publication refuses a substituted prior runtime marker", async () => {
  const f = await format2Fixture(false);
  try {
    await f.accept("checkpoint/Publishing/3");
    const filename = path.join(f.state, "runtime-storage.json");
    const original = readFileSync(filename, "utf-8");
    const changed = JSON.stringify({
      ...JSON.parse(original),
      targetBuild: "e".repeat(64),
    });
    writeFileSync(filename, changed);
    await expect(f.resume()).rejects.toMatchObject({
      code: "RevisionUnavailable",
    });
    expect(readFileSync(filename, "utf-8")).toBe(changed);
    writeFileSync(filename, original);
    const result = await f.resume();
    expect(result.phase).toBe("Complete");
    expect(readRuntimeStorage(f.repository)?.format).toBe(3);
  } finally {
    f.cleanup();
  }
});

test("format-2 assessment requires the original platform and completed predecessor receipt", async () => {
  const f = await format2Fixture(false);
  try {
    await expect(
      f.run(
        assessRuntimeUpgrade(f.repository, crypto.randomUUID(), {
          ...f.policy,
          platform: "different-platform",
        })
      )
    ).rejects.toMatchObject({ code: "RevisionUnavailable" });
    rmSync(path.join(f.state, `upgrade-history/${f.plan.planId}.json`));
    await expect(
      f.run(assessRuntimeUpgrade(f.repository, crypto.randomUUID(), f.policy))
    ).rejects.toMatchObject({ code: "RevisionUnavailable" });
  } finally {
    f.cleanup();
  }
});

test("a foreign empty-vault owner refuses with a typed error and leaves its data intact", async () => {
  const f = await format2Fixture(false);
  try {
    await f.accept();
    const filename = path.join(f.state, "vaults.sqlite");
    const db = new Database(filename);
    db.query("UPDATE effectory_upgrade_empty SET targetBuild=?").run(
      "e".repeat(64)
    );
    db.close();
    const before = readFileSync(filename);
    await expect(f.resume()).rejects.toMatchObject({
      code: "RevisionUnavailable",
    });
    expect(readFileSync(filename)).toEqual(before);
  } finally {
    f.cleanup();
  }
});

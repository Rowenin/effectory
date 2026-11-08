import { Database } from "bun:sqlite";
/* oxlint-disable no-bitwise -- Verify preserved executable bits. */
import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { Effect } from "effect";

import {
  createUpgradeRecoveryCopy,
  verifyUpgradeRecoveryCopy,
} from "../src/upgrade-copy.ts";
import { fileFence } from "../src/upgrade-file-fence.ts";
import { fingerprintUpgradeRepository } from "../src/upgrade-fingerprint.ts";
import { makeUpgradeJournal } from "../src/upgrade-journal.ts";
import { verifyProtectedSource } from "../src/upgrade-protected-source.ts";
import { readUpgradeFile } from "../src/upgrade-record-file.ts";
import { vaultFence } from "../src/upgrade-vault-fence.ts";
import { fenceFixture } from "./fixtures/upgrade-fence-fixture.ts";

test("format fences repeat and abort restores exact credential bytes, executable bits and absent lock", async () => {
  const f = fenceFixture();
  try {
    const filename = path.join(f.state, "credentials.json");
    chmodSync(filename, 0o700);
    await f.accept();
    await f.run(fileFence(f.repository, "Credentials", f.owner, "Protect"));
    await f.run(fileFence(f.repository, "Credentials", f.owner, "Protect"));
    expect(lstatSync(filename).mode & 0o111).toBe(0o100);
    await expect(
      f.run(
        fileFence(
          f.repository,
          "Credentials",
          { ...f.owner, planId: crypto.randomUUID() },
          "Abort"
        )
      )
    ).rejects.toMatchObject({ code: "RevisionUnavailable" });
    await f.run(fileFence(f.repository, "Extensions", f.owner, "Protect"));
    expect(
      existsSync(path.join(f.repository, "effectory.extensions.lock.json"))
    ).toBe(true);
    await f.run(fileFence(f.repository, "Extensions", f.owner, "Abort"));
    await f.run(fileFence(f.repository, "Credentials", f.owner, "Abort"));
    expect(
      existsSync(path.join(f.repository, "effectory.extensions.lock.json"))
    ).toBe(false);
    expect(readFileSync(filename, "utf-8")).toBe(f.credentials);
    expect(lstatSync(filename).mode & 0o111).toBe(0o100);
  } finally {
    f.cleanup();
  }
});

test("a vault created by an intervening old writer is preserved rather than replaced by an empty fence", async () => {
  const f = fenceFixture();
  try {
    f.seed();
    await f.accept();
    await expect(
      f.run(vaultFence(f.repository, f.owner, "Protect", false))
    ).rejects.toMatchObject({ code: "Conflict" });
    await f.run(vaultFence(f.repository, f.owner, "Abort", false));
    await f.finishAbort();
    const store = f.vault();
    try {
      expect(store.reveal("credentials", "token")).toBe("CANARY-fence-fixture");
    } finally {
      store.close();
    }
  } finally {
    f.cleanup();
  }
});

test("partial-fence comparison detects intervening deletion and abort never resurrects it from the recovery image", async () => {
  const f = fenceFixture();
  try {
    f.seed();
    const copy = await f.run(
      Effect.gen(function* () {
        const baseline = yield* fingerprintUpgradeRepository(f.repository);
        const journal = yield* makeUpgradeJournal(f.repository);
        const saved = yield* journal.savePlan({
          ...f.plan,
          source: {
            ...f.plan.source,
            dependencies: baseline.dependencies,
            identity: baseline.identity,
          },
        });
        const image = yield* createUpgradeRecoveryCopy(
          f.repository,
          f.plan.recoveryCopy,
          f.owner.planId
        );
        yield* journal.accept(
          {
            planDigest: saved.digest,
            planId: f.owner.planId,
            recoveryDigest: image.digest,
            sourceIdentity: baseline.identity,
            targetBuild: f.owner.targetBuild,
          },
          2
        );
        return image;
      })
    );
    const check = () =>
      f.run(
        Effect.gen(function* () {
          const manifest = yield* verifyUpgradeRecoveryCopy(
            copy.destination,
            f.owner.planId,
            copy.digest
          );
          return yield* verifyProtectedSource(
            f.repository,
            path.join(copy.destination, "repository"),
            manifest.entries,
            f.owner
          );
        })
      );
    expect(await check()).toBe(true);
    await f.run(fileFence(f.repository, "Credentials", f.owner, "Protect"));
    expect(await check()).toBe(true);
    // Simulate the old writer's logical deletion while its entry point is still unfenced.
    const old = new Database(path.join(f.state, "vaults.sqlite"));
    old.exec("DELETE FROM vault_values");
    old.close();
    expect(await check()).toBe(false);
    await f.run(vaultFence(f.repository, f.owner, "Abort", true));
    await f.run(fileFence(f.repository, "Credentials", f.owner, "Abort"));
    await f.finishAbort();
    const current = f.vault();
    try {
      expect(() => current.reveal("credentials", "token")).toThrow();
    } finally {
      current.close();
    }
  } finally {
    f.cleanup();
  }
});

test("staging substitutions and malformed UTF-8 refuse without changing linked files", async () => {
  const f = fenceFixture();
  try {
    await f.accept();
    const victim = path.join(f.directory, "victim");
    writeFileSync(victim, "keep");
    symlinkSync(victim, path.join(f.state, "upgrades", "vault-fence.sqlite"));
    await expect(
      f.run(vaultFence(f.repository, f.owner, "Protect", false))
    ).rejects.toMatchObject({ code: "RevisionUnavailable" });
    expect(readFileSync(victim, "utf-8")).toBe("keep");
    const bad = path.join(f.directory, "bad.json");
    writeFileSync(bad, Buffer.from([0x22, 0xff, 0x22]));
    expect(() => readUpgradeFile(bad, 100)).toThrow();
  } finally {
    f.cleanup();
  }
});

test.each([
  "file-staged",
  "file-installed",
  "vault-staging-created",
  "vault-staging-committed",
  "vault-staging-ready",
  "vault-linked",
  "vault-version-written",
  "vault-version-committed",
])(
  "fence survives SIGKILL at %s and restores the prior logical state",
  async (stage) => {
    const f = fenceFixture();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const original = stage.startsWith("vault-version");
      if (original) {
        f.seed();
      }
      await f.accept();
      const spawned = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "fixtures/upgrade-fence-crash.ts"),
          f.repository,
          f.owner.planId,
          f.owner.targetBuild,
          original ? "yes" : "no",
          stage,
        ],
        { stderr: "pipe", stdout: "pipe" }
      );
      child = spawned;
      timer = setTimeout(() => child?.kill("SIGKILL"), 10_000);
      const [code, stderr] = await Promise.all([
        spawned.exited,
        new Response(spawned.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(137);
      expect(readFileSync(path.join(f.directory, "checkpoint"), "utf-8")).toBe(
        stage
      );
      if (stage.startsWith("file-")) {
        await f.run(fileFence(f.repository, "Credentials", f.owner, "Protect"));
        await f.run(fileFence(f.repository, "Credentials", f.owner, "Abort"));
        expect(
          readFileSync(path.join(f.state, "credentials.json"), "utf-8")
        ).toBe(f.credentials);
      } else {
        await f.run(vaultFence(f.repository, f.owner, "Protect", original));
        await f.run(vaultFence(f.repository, f.owner, "Abort", original));
        if (original) {
          await f.finishAbort();
          const store = f.vault();
          try {
            expect(store.reveal("credentials", "token")).toBe(
              "CANARY-fence-fixture"
            );
          } finally {
            store.close();
          }
        } else {
          expect(existsSync(path.join(f.state, "vaults.sqlite"))).toBe(false);
        }
      }
    } finally {
      clearTimeout(timer);
      if (child?.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      f.cleanup();
    }
  },
  20_000
);

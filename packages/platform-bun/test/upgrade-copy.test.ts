/* oxlint-disable no-bitwise -- Check Unix permission bits on recovery files. */
/* oxlint-disable no-await-in-loop -- Crash barriers must be observed before killing their writer. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Exit } from "effect";

import { ownershipLayer } from "../src/ownership.ts";
import { snapshotMarker } from "../src/snapshot-marker.ts";
import {
  createUpgradeRecoveryCopy,
  verifyUpgradeRecoveryCopy,
} from "../src/upgrade-copy.ts";

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "effectory-upgrade-copy-"));
  const source = path.join(directory, "source");
  const state = path.join(source, ".effectory");
  mkdirSync(state, { recursive: true });
  mkdirSync(path.join(source, "empty"));
  mkdirSync(path.join(source, "node_modules"));
  writeFileSync(path.join(source, "node_modules", "excluded"), "dependencies");
  writeFileSync(
    path.join(source, "effectory.ts"),
    "throw new Error('never execute source while copying')"
  );
  writeFileSync(path.join(source, "script.sh"), "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });
  const filename = path.join(state, "state.sqlite");
  const db = new Database(filename);
  db.run(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('committed-in-wal')"
  );
  const destination = path.join(directory, "recovery");
  const planId = crypto.randomUUID();
  const own = ownershipLayer(`${filename}.owner`);
  return { db, destination, directory, filename, own, planId, source };
}
const hash = (filename: string) =>
  createHash("sha256").update(readFileSync(filename)).digest("hex");

test.each([
  "owner",
  "wal",
  "shm",
  "journal",
  "hard-link",
  "state-directory",
] as const)(
  "verification rejects substituted %s before acquiring the copy's SQLite lease",
  async (substitution) => {
    const f = fixture();
    try {
      const result = await Effect.runPromise(
        createUpgradeRecoveryCopy(f.source, f.destination, f.planId).pipe(
          Effect.scoped,
          Effect.provide(f.own)
        )
      );
      const unrelated = path.join(f.directory, "unrelated");
      mkdirSync(unrelated);
      const victim = path.join(unrelated, "state.sqlite.owner");
      const db = new Database(victim);
      db.close();
      chmodSync(victim, 0o400);
      const before = { digest: hash(victim), mode: lstatSync(victim).mode };
      const state = path.join(f.destination, "repository", ".effectory");
      if (substitution === "state-directory") {
        renameSync(state, path.join(f.directory, "saved-state"));
        symlinkSync(unrelated, state);
      } else {
        const suffix =
          substitution === "owner" || substitution === "hard-link"
            ? ""
            : `-${substitution}`;
        const owner = path.join(state, `state.sqlite.owner${suffix}`);
        if (existsSync(owner)) {
          unlinkSync(owner);
        }
        if (substitution === "hard-link") {
          linkSync(victim, owner);
        } else {
          symlinkSync(victim, owner);
        }
      }
      const failure = await Effect.runPromise(
        verifyUpgradeRecoveryCopy(f.destination, f.planId, result.digest).pipe(
          Effect.flip,
          Effect.scoped,
          Effect.provide(f.own)
        )
      );
      expect(failure.code).toBe("InvalidInput");
      expect({ digest: hash(victim), mode: lstatSync(victim).mode }).toEqual(
        before
      );
    } finally {
      f.db.close();
      rmSync(f.directory, { force: true, recursive: true });
    }
  }
);

test("verified external recovery copy preserves crash WAL, empty directories and executable files while holding the image offline", async () => {
  const f = fixture();
  try {
    const before = ["", "-wal", "-shm"].map((suffix) =>
      hash(f.filename + suffix)
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const image = yield* createUpgradeRecoveryCopy(
          f.source,
          f.destination,
          f.planId
        );
        const other = yield* Effect.exit(
          Effect.void.pipe(
            Effect.provide(
              ownershipLayer(
                path.join(
                  f.destination,
                  "repository",
                  ".effectory",
                  "state.sqlite.owner"
                )
              )
            )
          )
        );
        expect(Exit.isFailure(other)).toBe(true);
        return image;
      }).pipe(Effect.scoped, Effect.provide(f.own))
    );
    expect(
      existsSync(path.join(f.destination, "repository", snapshotMarker))
    ).toBe(false);
    expect(
      existsSync(path.join(f.destination, "repository", "node_modules"))
    ).toBe(false);
    expect(existsSync(path.join(f.destination, "repository", "empty"))).toBe(
      true
    );
    expect(
      lstatSync(path.join(f.destination, "repository", "script.sh")).mode &
        0o777
    ).toBe(0o700);
    expect(
      lstatSync(path.join(f.destination, "repository", "effectory.ts")).mode &
        0o777
    ).toBe(0o600);
    const verified = await Effect.runPromise(
      verifyUpgradeRecoveryCopy(f.destination, f.planId, result.digest).pipe(
        Effect.scoped,
        Effect.provide(f.own)
      )
    );
    expect(verified).toEqual(result.manifest);
    expect(
      ["", "-wal", "-shm"].map((suffix) => hash(f.filename + suffix))
    ).toEqual(before);
    // Simulate using the completed copy for rollback: SQLite sees the committed
    // WAL value. This consumes a disposable copy, not the source repository.
    const restored = new Database(
      path.join(f.destination, "repository", ".effectory", "state.sqlite")
    );
    try {
      expect(restored.query("SELECT value FROM evidence").get()).toEqual({
        value: "committed-in-wal",
      });
    } finally {
      restored.close();
    }
  } finally {
    f.db.close();
    rmSync(f.directory, { force: true, recursive: true });
  }
});

test("recovery copy supports a file larger than the built-in backup's 128 MiB limit with chunked verification", async () => {
  const f = fixture();
  try {
    const large = path.join(f.source, "large.data");
    writeFileSync(large, "header");
    truncateSync(large, 134_217_729);
    const result = await Effect.runPromise(
      createUpgradeRecoveryCopy(f.source, f.destination, f.planId).pipe(
        Effect.scoped,
        Effect.provide(f.own)
      )
    );
    const file = result.manifest.entries.find(
      (entry) => entry.path === "large.data"
    );
    expect(file?.kind === "File" && file.bytes).toBe(134_217_729);
    expect(
      lstatSync(path.join(f.destination, "repository", "large.data")).size
    ).toBe(134_217_729);
    const verified = await Effect.runPromise(
      verifyUpgradeRecoveryCopy(f.destination, f.planId, result.digest).pipe(
        Effect.scoped,
        Effect.provide(f.own)
      )
    );
    expect(verified.planId).toBe(f.planId);
  } finally {
    f.db.close();
    rmSync(f.directory, { force: true, recursive: true });
  }
}, 30_000);

test("a source change during copying leaves a refused incomplete image and never restores over that change", async () => {
  const f = fixture();
  try {
    const failure = await Effect.runPromise(
      createUpgradeRecoveryCopy(f.source, f.destination, f.planId, (stage) =>
        stage === "created"
          ? Effect.sync(() =>
              writeFileSync(
                path.join(f.source, "effectory.ts"),
                "operator edit"
              )
            )
          : Effect.void
      ).pipe(Effect.flip, Effect.scoped, Effect.provide(f.own))
    );
    expect(failure.code).toBe("Conflict");
    expect(readFileSync(path.join(f.source, "effectory.ts"), "utf-8")).toBe(
      "operator edit"
    );
    expect(
      existsSync(path.join(f.destination, "repository", snapshotMarker))
    ).toBe(true);
    expect(existsSync(path.join(f.destination, "manifest.json"))).toBe(false);
  } finally {
    f.db.close();
    rmSync(f.directory, { force: true, recursive: true });
  }
});

test.each(["content", "manifest", "execute", "extra"] as const)(
  "verification refuses changed recovery-copy %s",
  async (change) => {
    const f = fixture();
    try {
      const result = await Effect.runPromise(
        createUpgradeRecoveryCopy(f.source, f.destination, f.planId).pipe(
          Effect.scoped,
          Effect.provide(f.own)
        )
      );
      if (change === "content") {
        writeFileSync(
          path.join(f.destination, "repository", "effectory.ts"),
          "changed"
        );
      }
      if (change === "manifest") {
        writeFileSync(path.join(f.destination, "manifest.json"), "{}");
      }
      if (change === "execute") {
        chmodSync(path.join(f.destination, "repository", "script.sh"), 0o600);
      }
      if (change === "extra") {
        writeFileSync(
          path.join(f.destination, "repository", "extra"),
          "changed"
        );
      }
      const failure = await Effect.runPromise(
        verifyUpgradeRecoveryCopy(f.destination, f.planId, result.digest).pipe(
          Effect.flip,
          Effect.scoped,
          Effect.provide(f.own)
        )
      );
      expect(failure.code).toBe("Conflict");
    } finally {
      f.db.close();
      rmSync(f.directory, { force: true, recursive: true });
    }
  }
);

test.each(["created", "copied-entry", "verified", "manifest-published"])(
  "process death at %s never publishes a usable rollback image",
  async (stage) => {
    const f = fixture();
    const marker = path.join(f.directory, "barrier");
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "fixtures/upgrade-copy-worker.ts"),
        f.source,
        f.destination,
        f.planId,
        stage,
        marker,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    try {
      const deadline = Date.now() + 10_000;
      while (
        !existsSync(marker) &&
        child.exitCode === null &&
        Date.now() < deadline
      ) {
        await Bun.sleep(10);
      }
      expect(existsSync(marker)).toBe(true);
      child.kill("SIGKILL");
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
      expect(
        existsSync(path.join(f.destination, "repository", snapshotMarker))
      ).toBe(true);
      const failure = await Effect.runPromise(
        verifyUpgradeRecoveryCopy(f.destination, f.planId, "a".repeat(64)).pipe(
          Effect.flip,
          Effect.scoped,
          Effect.provide(f.own)
        )
      );
      expect(failure.code).toBe("Conflict");
      expect(failure.message).toContain("incomplete");
      // Process death releases both OS leases. No PID-based takeover is involved.
      await Effect.runPromise(
        Effect.void.pipe(
          Effect.provide(
            ownershipLayer(
              path.join(
                f.destination,
                "repository",
                ".effectory",
                "state.sqlite.owner"
              )
            )
          )
        )
      );
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      f.db.close();
      rmSync(f.directory, { force: true, recursive: true });
    }
  },
  15_000
);

test("copy refuses source symlinks and an in-repository destination before creating a recovery image", async () => {
  const f = fixture();
  try {
    const nested = path.join(f.source, "recovery");
    const inside = await Effect.runPromise(
      createUpgradeRecoveryCopy(f.source, nested, f.planId).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(f.own)
      )
    );
    expect(inside.code).toBe("InvalidInput");
    expect(existsSync(nested)).toBe(false);
    symlinkSync("effectory.ts", path.join(f.source, "linked"));
    const link = await Effect.runPromise(
      createUpgradeRecoveryCopy(f.source, f.destination, f.planId).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(f.own)
      )
    );
    expect(link.code).toBe("InvalidInput");
    expect(existsSync(f.destination)).toBe(false);
  } finally {
    f.db.close();
    rmSync(f.directory, { force: true, recursive: true });
  }
});

/* oxlint-disable no-await-in-loop -- Each maintenance writer must reach the gate without competing for the lease. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Schema } from "effect";

import { digestOf } from "../src/application-bundle.ts";
import { createStore } from "../src/host-store.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { reclaimRevisions } from "../src/revision-reclaim-commands.ts";
import { ReclaimPreview } from "../src/revision-reclaim-journal-record.ts";
import { makeReclaimJournal } from "../src/revision-reclaim-journal.ts";
import {
  RevisionReclaimInspection,
  RevisionReclaimPlan,
  RevisionReclaimReceipt,
} from "../src/revision-reclaim-record.ts";

function fixture() {
  const repository = mkdtempSync(
    path.join(tmpdir(), "effectory-reclaim-commands-")
  );
  const state = path.join(repository, ".effectory");
  mkdirSync(path.join(state, "revisions"), { recursive: true });
  writeFileSync(
    path.join(state, "credentials.json"),
    JSON.stringify({ repositoryId: "test-repository", token: "synthetic" })
  );
  writeFileSync(path.join(repository, "package.json"), '{"dependencies":{}}');
  writeFileSync(
    path.join(repository, "effectory.ts"),
    'throw new Error("source must never execute");'
  );
  const add = (n: number) => {
    const source = `throw new Error("archived bundle ${n} must never execute");`;
    const manifest = {
      digest: digestOf(source),
      effectVersion: "archived",
      extensionDigests: [],
      format: 2,
      hostAbi: "f".repeat(64),
    };
    const revision = digestOf(`${manifest.hostAbi}/${manifest.digest}`);
    const directory = path.join(state, "revisions", revision);
    mkdirSync(directory);
    writeFileSync(path.join(directory, "application.mjs"), source);
    writeFileSync(
      path.join(directory, "manifest.json"),
      JSON.stringify(manifest)
    );
    return { directory, revision };
  };
  const active = add(1);
  const unused = add(2);
  writeFileSync(
    path.join(state, "active.json"),
    JSON.stringify({ revision: active.revision })
  );
  const mutate = (
    body: (db: Database, store: ReturnType<typeof createStore>) => void
  ) => {
    const db = new Database(path.join(state, "state.sqlite"));
    try {
      body(db, createStore(db, { assertActive: () => {}, token: "fixture" }));
    } finally {
      db.close();
    }
  };
  mutate(() => {});
  const plan = async (selected?: string) =>
    Schema.decodeUnknownSync(RevisionReclaimPlan)(
      await Effect.runPromise(
        reclaimRevisions(repository, {
          kind: "Plan",
          selector: selected
            ? { _tag: "Revision", revision: selected }
            : { _tag: "Unreferenced" },
        })
      )
    );
  const apply = (planId: string) =>
    reclaimRevisions(repository, { kind: "Apply", planId });
  return {
    active,
    add,
    apply,
    close: () => rmSync(repository, { force: true, recursive: true }),
    mutate,
    plan,
    repository,
    state,
    unused,
  };
}

test("offline plan/apply/inspect remove only unused archived code without importing source, and receipts precede recapture", async () => {
  const f = fixture();
  try {
    const database = path.join(f.state, "state.sqlite");
    const before = digestOf(readFileSync(database));
    const plan = await f.plan();
    expect(plan.status).toBe("Ready");
    expect(plan.candidates.map((item) => item.revision)).toEqual([
      f.unused.revision,
    ]);
    expect(plan.protected[0]?.revision).toBe(f.active.revision);
    expect(plan.retainedCount).toBe(2);
    expect(digestOf(readFileSync(database))).toBe(before);
    const inspected = Schema.decodeUnknownSync(RevisionReclaimInspection)(
      await Effect.runPromise(
        reclaimRevisions(f.repository, { kind: "Inspect", planId: plan.planId })
      )
    );
    expect(inspected).toEqual({
      completedRevisions: 0,
      phase: "Planned",
      plan,
      receipt: null,
    });
    const receipt = Schema.decodeUnknownSync(RevisionReclaimReceipt)(
      await Effect.runPromise(f.apply(plan.planId))
    );
    expect(receipt.removedFiles).toBe(2);
    expect(existsSync(f.unused.directory)).toBe(false);
    expect(existsSync(f.active.directory)).toBe(true);
    expect(digestOf(readFileSync(database))).toBe(before);
    f.add(2);
    writeFileSync(
      path.join(f.repository, "package.json"),
      "changed after receipt"
    );
    expect(await Effect.runPromise(f.apply(plan.planId))).toEqual(receipt);
    expect(existsSync(f.unused.directory)).toBe(true);
  } finally {
    f.close();
  }
});

test.each(["package", "workspace", "active", "run", "manifest", "bundle"])(
  "changed %s refuses the whole preview before acceptance",
  async (change) => {
    const f = fixture();
    try {
      const plan = await f.plan();
      if (change === "package") {
        writeFileSync(
          path.join(f.repository, "package.json"),
          '{"dependencies":{"new":"1"}}'
        );
      }
      if (change === "workspace") {
        mkdirSync(path.join(f.repository, "child"));
        writeFileSync(path.join(f.repository, "child", "package.json"), "{}");
      }
      if (change === "active") {
        writeFileSync(
          path.join(f.state, "active.json"),
          JSON.stringify({ revision: f.unused.revision })
        );
      }
      if (change === "manifest") {
        const name = path.join(f.unused.directory, "manifest.json");
        writeFileSync(name, `${readFileSync(name, "utf-8")}\n`);
      }
      if (change === "bundle") {
        writeFileSync(
          path.join(f.unused.directory, "application.mjs"),
          "changed bundle"
        );
      }
      if (change === "run") {
        f.mutate((_, store) => {
          Effect.runSync(
            store.submit(
              {
                input: null,
                kind: "task",
                requestKey: "new",
                targetId: "source",
              },
              f.unused.revision,
              "other-principal"
            )
          );
        });
      }
      const error = await Effect.runPromise(
        f.apply(plan.planId).pipe(Effect.flip)
      );
      expect(error.code).toBe("Conflict");
      expect(existsSync(path.join(f.state, "upgrades", "active.json"))).toBe(
        false
      );
      expect(existsSync(f.unused.directory)).toBe(true);
      expect(existsSync(f.active.directory)).toBe(true);
    } finally {
      f.close();
    }
  }
);

test("a forged Ready preview with the original binding cannot delete active code", async () => {
  const f = fixture();
  try {
    const plan = await f.plan();
    const filename = path.join(
      f.state,
      "revision-reclaims",
      "plans",
      `${plan.planId}.json`
    );
    const saved = JSON.parse(readFileSync(filename, "utf-8"));
    const manifest = readFileSync(
      path.join(f.active.directory, "manifest.json")
    );
    const bundle = readFileSync(
      path.join(f.active.directory, "application.mjs")
    );
    saved.plan.candidates = [
      {
        bundleDigest: digestOf(bundle),
        bytes: manifest.length + bundle.length,
        executionContract: null,
        hostBuild: "f".repeat(64),
        manifestDigest: digestOf(manifest),
        revision: f.active.revision,
      },
    ];
    saved.plan.protected = [];
    saved.plan.logicalBytes = manifest.length + bundle.length;
    writeFileSync(filename, JSON.stringify(saved));
    const refused = await Effect.runPromise(
      f.apply(plan.planId).pipe(Effect.flip)
    );
    expect(refused.code).toBe("Conflict");
    expect(existsSync(f.active.directory)).toBe(true);
  } finally {
    f.close();
  }
});

test("protected selection is non-applicable; unknown identifiers and ownership conflicts are typed", async () => {
  const f = fixture();
  try {
    const plan = await f.plan(f.active.revision);
    expect(plan.status).toBe("NoCandidates");
    const refused = await Effect.runPromise(
      f.apply(plan.planId).pipe(Effect.flip)
    );
    expect(refused.code).toBe("Conflict");
    const unknownRevision = await Effect.runPromise(
      reclaimRevisions(f.repository, {
        kind: "Plan",
        selector: { _tag: "Revision", revision: "0".repeat(64) },
      }).pipe(Effect.flip)
    );
    expect(unknownRevision.code).toBe("NotFound");
    const unknownPlan = await Effect.runPromise(
      f.apply(crypto.randomUUID()).pipe(Effect.flip)
    );
    expect(unknownPlan.code).toBe("NotFound");
    const busy = await Effect.runPromise(
      reclaimRevisions(f.repository, {
        kind: "Plan",
        selector: { _tag: "Unreferenced" },
      }).pipe(
        Effect.flip,
        Effect.provide(ownershipLayer(path.join(f.state, "state.sqlite.owner")))
      )
    );
    expect(busy.code).toBe("Conflict");
  } finally {
    f.close();
  }
});

test("real CLI plans, inspects and applies offline, and validates explicit selection", async () => {
  const f = fixture();
  const main = path.resolve(import.meta.dir, "../../cli/src/main.ts");
  const cli = async (...args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        main,
        "revision",
        "reclaim",
        ...args,
        "--repository",
        f.repository,
        "--json",
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stderr, stdout };
  };
  try {
    const missingSelector = await cli("plan");
    expect(missingSelector.code).toBe(2);
    const duplicateSelector = await cli(
      "plan",
      "--unreferenced",
      "--revision",
      f.active.revision
    );
    expect(duplicateSelector.code).toBe(2);
    const result = await cli("plan", "--unreferenced");
    expect(result.code, result.stderr).toBe(0);
    const plan = Schema.decodeUnknownSync(RevisionReclaimPlan)(
      JSON.parse(result.stdout)
    );
    const inspection = await cli("inspect", plan.planId);
    expect(inspection.code).toBe(0);
    const applied = await cli("apply", plan.planId);
    expect(applied.code, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout).removedFiles).toBe(2);
    expect(existsSync(path.join(f.state, "daemon.json"))).toBe(false);
  } finally {
    f.close();
  }
}, 60_000);

test("accepted deletion gates ordinary CLI writers and resumes only through apply", async () => {
  const f = fixture();
  const main = path.resolve(import.meta.dir, "../../cli/src/main.ts");
  const destination = `${f.repository}-backup`;
  try {
    const plan = await f.plan();
    const saved = Schema.decodeUnknownSync(ReclaimPreview)(
      JSON.parse(
        readFileSync(
          path.join(
            f.state,
            "revision-reclaims",
            "plans",
            `${plan.planId}.json`
          ),
          "utf-8"
        )
      )
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* makeReclaimJournal(f.repository);
        yield* journal.accept(
          plan.planId,
          saved.binding,
          plan.hostBuild,
          Date.now()
        );
      }).pipe(
        Effect.provide(ownershipLayer(path.join(f.state, "state.sqlite.owner")))
      )
    );
    const gate = path.join(f.state, "upgrades", "active.json");
    const before = readFileSync(gate, "utf-8");
    const database = readFileSync(path.join(f.state, "state.sqlite"));
    const commands = [
      ["daemon", "serve"],
      ["upgrade"],
      ["init"],
      ["upgrade", "plan"],
      ["revision", "reclaim", "plan", "--unreferenced"],
      ["run", "reclaim", "compact"],
      ["extension", "restore"],
      ["vault", "reset", "test", "--discard"],
      ["backup", destination],
    ];
    for (const args of commands) {
      const child = Bun.spawn(
        [
          process.execPath,
          main,
          ...args,
          "--repository",
          f.repository,
          "--json",
        ],
        { stderr: "pipe", stdout: "pipe" }
      );
      const [stderr, stdout, code] = await Promise.all([
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
        child.exited,
      ]);
      expect(code, `${args.join(" ")}: ${stderr} ${stdout}`).not.toBe(0);
      expect(stderr).toContain(`revision reclaim apply ${plan.planId}`);
    }
    expect(readFileSync(gate, "utf-8")).toBe(before);
    expect(readFileSync(path.join(f.state, "state.sqlite"))).toEqual(database);
    const inspected = Schema.decodeUnknownSync(RevisionReclaimInspection)(
      await Effect.runPromise(
        reclaimRevisions(f.repository, { kind: "Inspect", planId: plan.planId })
      )
    );
    expect(inspected.phase).toBe("Applying");
    expect(existsSync(f.unused.directory)).toBe(true);
    writeFileSync(
      path.join(f.repository, "package.json"),
      "changed after acceptance"
    );
    const receipt = Schema.decodeUnknownSync(RevisionReclaimReceipt)(
      await Effect.runPromise(f.apply(plan.planId))
    );
    expect(receipt.removedFiles).toBe(2);
    expect(existsSync(gate)).toBe(false);
  } finally {
    f.close();
    rmSync(destination, { force: true, recursive: true });
  }
}, 60_000);

const boundaries = [
  "accepted",
  "renamed",
  "rename-synced",
  "Quarantined",
  "bundle-unlinked",
  "bundle-unlink-synced",
  "BundleRemoved",
  "manifest-unlinked",
  "manifest-unlink-synced",
  "ManifestRemoved",
  "directory-removed",
  "directory-removal-synced",
  "Complete",
  "quarantine-cleared",
  "receipt",
  "released",
];
test.each(boundaries)(
  "command admission killed at %s resumes through the real CLI",
  async (boundary) => {
    const f = fixture();
    const copied = `${f.repository}-copy`;
    try {
      const plan = await f.plan();
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(
            import.meta.dir,
            "fixtures/revision-reclaim-command-kill.ts"
          ),
          f.repository,
          plan.planId,
          boundary,
        ],
        { stderr: "pipe", stdout: "ignore" }
      );
      const stderr = new Response(child.stderr).text();
      await child.exited;
      expect(child.signalCode, await stderr).toBe("SIGKILL");
      const target = boundary === "bundle-unlinked" ? copied : f.repository;
      if (target === copied) {
        cpSync(f.repository, copied, { recursive: true });
      }
      const result = Bun.spawnSync(
        [
          process.execPath,
          path.resolve(import.meta.dir, "../../cli/src/main.ts"),
          "revision",
          "reclaim",
          "apply",
          plan.planId,
          "--repository",
          target,
          "--json",
        ],
        { stderr: "pipe", stdout: "pipe" }
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const receipt = Schema.decodeUnknownSync(RevisionReclaimReceipt)(
        JSON.parse(result.stdout.toString())
      );
      expect(receipt.removedFiles).toBe(2);
      expect(receipt.logicalBytes).toBe(plan.logicalBytes);
      expect(
        existsSync(
          path.join(target, ".effectory", "revisions", f.active.revision)
        )
      ).toBe(true);
      expect(
        existsSync(
          path.join(target, ".effectory", "revisions", f.unused.revision)
        )
      ).toBe(false);
      expect(
        await Effect.runPromise(
          reclaimRevisions(target, { kind: "Apply", planId: plan.planId })
        )
      ).toEqual(receipt);
      if (target === copied) {
        expect(existsSync(path.join(f.state, "upgrades", "active.json"))).toBe(
          true
        );
        expect(await Effect.runPromise(f.apply(plan.planId))).toMatchObject({
          removedFiles: 2,
          revisions: receipt.revisions,
        });
      }
    } finally {
      f.close();
      rmSync(copied, { force: true, recursive: true });
    }
  },
  15_000
);

test("filesystem loss after rename leaves Applying and resumes after the directory returns", async () => {
  const f = fixture();
  try {
    const plan = await f.plan();
    const quarantine = path.join(f.state, "revision-reclaims", "quarantine");
    const held = path.join(f.state, "revision-reclaims", "held-by-test");
    const failure = await Effect.runPromise(
      reclaimRevisions(
        f.repository,
        { kind: "Apply", planId: plan.planId },
        (name) =>
          Effect.sync(() => {
            if (name === "renamed") {
              renameSync(quarantine, held);
            }
          })
      ).pipe(Effect.flip)
    );
    expect(failure.code).toBe("Unavailable");
    expect(failure.message).toContain(`revision reclaim apply ${plan.planId}`);
    const inspected = Schema.decodeUnknownSync(RevisionReclaimInspection)(
      await Effect.runPromise(
        reclaimRevisions(f.repository, { kind: "Inspect", planId: plan.planId })
      )
    );
    expect(inspected.phase).toBe("Applying");
    expect(existsSync(path.join(f.state, "upgrades", "active.json"))).toBe(
      true
    );
    renameSync(held, quarantine);
    expect(await Effect.runPromise(f.apply(plan.planId))).toMatchObject({
      removedFiles: 2,
    });
    expect(existsSync(f.active.directory)).toBe(true);
  } finally {
    f.close();
  }
});

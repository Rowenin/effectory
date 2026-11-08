import { expect, test } from "bun:test";
import {
  existsSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Exit } from "effect";

import { digestOf } from "../src/application-bundle.ts";
import { ownershipLayer } from "../src/ownership.ts";
import type { Lease } from "../src/ownership.ts";
import { reclaimRevisionFiles } from "../src/revision-reclaim-executor.ts";
import { inventoryReclaimRevisions } from "../src/revision-reclaim-inventory.ts";
import type { ReclaimPreview } from "../src/revision-reclaim-journal-record.ts";
import { makeReclaimJournal } from "../src/revision-reclaim-journal.ts";
import { assertUpgradeIdle } from "../src/upgrade-transition-gate.ts";

const build = "a".repeat(64);
const binding = "c".repeat(64);
async function fixture() {
  const repository = mkdtempSync(
    path.join(tmpdir(), "effectory-reclaim-delete-")
  );
  const state = path.join(repository, ".effectory");
  const revisions = path.join(state, "revisions");
  mkdirSync(revisions, { recursive: true });
  writeFileSync(
    path.join(state, "credentials.json"),
    JSON.stringify({ repositoryId: "repository", token: "synthetic" })
  );
  const add = (n: number) => {
    const contents = `throw new Error("must not execute archived revision ${n}");`;
    const manifest = {
      digest: digestOf(contents),
      effectVersion: "archived",
      extensionDigests: [],
      format: 2,
      hostAbi: "f".repeat(64),
    };
    const revision = digestOf(`${manifest.hostAbi}/${manifest.digest}`);
    const directory = path.join(revisions, revision);
    mkdirSync(directory);
    writeFileSync(path.join(directory, "application.mjs"), contents);
    writeFileSync(
      path.join(directory, "manifest.json"),
      JSON.stringify(manifest)
    );
    return { contents, directory, manifest, revision };
  };
  const selected = [add(1), add(2)];
  const protectedRevision = add(3);
  const run = async <A, E>(effect: Effect.Effect<A, E, Lease>) =>
    await Effect.runPromise(
      effect.pipe(
        Effect.provide(ownershipLayer(path.join(state, "state.sqlite.owner")))
      )
    );
  const inventory = await run(inventoryReclaimRevisions(repository));
  const candidates = inventory.filter(
    (item) => item.revision !== protectedRevision.revision
  );
  const now = Date.now();
  const value: typeof ReclaimPreview.Type = {
    architecture: process.arch,
    binding,
    format: 1,
    plan: {
      candidates,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 900_000).toISOString(),
      hostBuild: build,
      logicalBytes: candidates.reduce((n, candidate) => n + candidate.bytes, 0),
      planId: crypto.randomUUID(),
      projectedRetainedCount: 1,
      protected: [
        {
          examplesTruncated: false,
          reasons: [{ count: 1, examples: ["active.json"], kind: "Active" }],
          revision: protectedRevision.revision,
        },
      ],
      repositoryId: "repository",
      retainedCount: 3,
      scannedBytes: 1,
      scannedRows: 1,
      selector: { _tag: "Unreferenced" },
      status: "Ready",
    },
    platform: process.platform,
  };
  await run(
    Effect.flatMap(makeReclaimJournal(repository), (j) => j.save(value, now))
  );
  return {
    close: () => rmSync(repository, { force: true, recursive: true }),
    protectedRevision,
    repository,
    run,
    selected,
    state,
    value,
  };
}
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
  "real SIGKILL at %s resumes accepted bundle deletion once and preserves protected code",
  async (boundary) => {
    const f = await fixture();
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "fixtures/revision-reclaim-kill.ts"),
          f.repository,
          f.value.plan.planId,
          boundary,
        ],
        { stderr: "pipe", stdout: "ignore" }
      );
      const stderr = new Response(child.stderr).text();
      await child.exited;
      expect(child.signalCode, await stderr).toBe("SIGKILL");
      if (boundary !== "released") {
        expect(() => assertUpgradeIdle(f.repository)).toThrow(
          `revision reclaim apply ${f.value.plan.planId}`
        );
      }
      const receipt = await f.run(
        reclaimRevisionFiles(f.repository, f.value.plan.planId, build)
      );
      expect(receipt?.removedFiles).toBe(4);
      expect(receipt?.logicalBytes).toBe(f.value.plan.logicalBytes);
      expect(receipt?.revisions).toEqual(
        f.value.plan.candidates.map((candidate) => candidate.revision)
      );
      expect(() => assertUpgradeIdle(f.repository)).not.toThrow();
      expect(readdirSync(path.join(f.state, "revisions"))).toEqual([
        f.protectedRevision.revision,
      ]);
      expect(
        readFileSync(
          path.join(f.protectedRevision.directory, "application.mjs"),
          "utf-8"
        )
      ).toBe(f.protectedRevision.contents);
      expect(
        await f.run(
          reclaimRevisionFiles(f.repository, f.value.plan.planId, build)
        )
      ).toEqual(receipt);
    } finally {
      f.close();
    }
  },
  10_000
);

test("unaccepted deletion changes nothing and external hard links survive accepted removal", async () => {
  const f = await fixture();
  try {
    const refused = await f.run(
      reclaimRevisionFiles(f.repository, f.value.plan.planId, build).pipe(
        Effect.flip
      )
    );
    expect(refused.code).toBe("Conflict");
    const [selected] = f.selected;
    if (!selected) {
      throw new Error("Missing selected revision");
    }
    const external = path.join(f.repository, "external-hardlink");
    linkSync(path.join(selected.directory, "application.mjs"), external);
    await f.run(
      Effect.flatMap(makeReclaimJournal(f.repository), (j) =>
        j.accept(f.value.plan.planId, binding, build, Date.now())
      )
    );
    const receipt = await f.run(
      reclaimRevisionFiles(f.repository, f.value.plan.planId, build)
    );
    expect(readFileSync(external, "utf-8")).toBe(selected.contents);
    mkdirSync(selected.directory);
    writeFileSync(
      path.join(selected.directory, "application.mjs"),
      "recreated"
    );
    expect(
      await f.run(
        reclaimRevisionFiles(f.repository, f.value.plan.planId, build)
      )
    ).toEqual(receipt);
    expect(
      readFileSync(path.join(selected.directory, "application.mjs"), "utf-8")
    ).toBe("recreated");
  } finally {
    f.close();
  }
});

test.each(["changed", "extra", "symlink", "foreign-repository"])(
  "accepted deletion refuses %s files and keeps its recovery gate",
  async (fault) => {
    const f = await fixture();
    try {
      await f.run(
        Effect.flatMap(makeReclaimJournal(f.repository), (j) =>
          j.accept(f.value.plan.planId, binding, build, Date.now())
        )
      );
      const [candidate] = f.value.plan.candidates;
      if (!candidate) {
        throw new Error("Missing candidate");
      }
      const source = path.join(f.state, "revisions", candidate.revision);
      if (fault === "changed") {
        writeFileSync(path.join(source, "application.mjs"), "changed");
      }
      if (fault === "extra") {
        writeFileSync(path.join(source, "extra"), "unrelated");
      }
      if (fault === "symlink") {
        rmSync(path.join(source, "application.mjs"));
        symlinkSync(
          path.join(f.protectedRevision.directory, "application.mjs"),
          path.join(source, "application.mjs")
        );
      }
      if (fault === "foreign-repository") {
        writeFileSync(
          path.join(f.state, "credentials.json"),
          JSON.stringify({ repositoryId: "other", token: "synthetic" })
        );
      }
      const failure = await f.run(
        reclaimRevisionFiles(f.repository, f.value.plan.planId, build).pipe(
          Effect.flip
        )
      );
      expect(failure.code).toBe("RevisionUnavailable");
      expect(existsSync(source)).toBe(true);
      expect(
        readFileSync(
          path.join(f.protectedRevision.directory, "application.mjs"),
          "utf-8"
        )
      ).toBe(f.protectedRevision.contents);
      expect(() => assertUpgradeIdle(f.repository)).toThrow(
        "revision reclaim apply"
      );
    } finally {
      f.close();
    }
  }
);

test("changed quarantined content refuses before any unlink", async () => {
  const f = await fixture();
  try {
    await f.run(
      Effect.flatMap(makeReclaimJournal(f.repository), (j) =>
        j.accept(f.value.plan.planId, binding, build, Date.now())
      )
    );
    const interrupted = await f.run(
      Effect.exit(
        reclaimRevisionFiles(f.repository, f.value.plan.planId, build, (name) =>
          name === "Quarantined" ? Effect.die("stop") : Effect.void
        )
      )
    );
    expect(Exit.isFailure(interrupted)).toBe(true);
    const [first] = f.value.plan.candidates;
    if (!first) {
      throw new Error("Missing candidate");
    }
    const target = path.join(
      f.state,
      "revision-reclaims/quarantine",
      f.value.plan.planId,
      first.revision
    );
    writeFileSync(
      path.join(target, "application.mjs"),
      "changed in quarantine"
    );
    const failure = await f.run(
      reclaimRevisionFiles(f.repository, f.value.plan.planId, build).pipe(
        Effect.flip
      )
    );
    expect(failure.code).toBe("RevisionUnavailable");
    expect(readdirSync(target).toSorted()).toEqual([
      "application.mjs",
      "manifest.json",
    ]);
  } finally {
    f.close();
  }
});

test("an offline copy preserves accepted recovery and resumes independently on the accepting host", async () => {
  const f = await fixture();
  const copied = `${f.repository}-copy`;
  try {
    await f.run(
      Effect.flatMap(makeReclaimJournal(f.repository), (j) =>
        j.accept(f.value.plan.planId, binding, build, Date.now())
      )
    );
    const interrupted = await f.run(
      Effect.exit(
        reclaimRevisionFiles(f.repository, f.value.plan.planId, build, (name) =>
          name === "bundle-unlinked"
            ? Effect.die("stop before journal")
            : Effect.void
        )
      )
    );
    expect(Exit.isFailure(interrupted)).toBe(true);
    cpSync(f.repository, copied, { recursive: true });
    expect(() => assertUpgradeIdle(copied)).toThrow("revision reclaim apply");
    const receipt = await Effect.runPromise(
      reclaimRevisionFiles(copied, f.value.plan.planId, build).pipe(
        Effect.provide(
          ownershipLayer(path.join(copied, ".effectory/state.sqlite.owner"))
        )
      )
    );
    expect(receipt?.removedFiles).toBe(4);
    expect(() => assertUpgradeIdle(copied)).not.toThrow();
    expect(() => assertUpgradeIdle(f.repository)).toThrow(
      "revision reclaim apply"
    );
    expect(
      readFileSync(
        path.join(
          copied,
          ".effectory/revisions",
          f.protectedRevision.revision,
          "application.mjs"
        ),
        "utf-8"
      )
    ).toBe(f.protectedRevision.contents);
    const original = await f.run(
      reclaimRevisionFiles(f.repository, f.value.plan.planId, build)
    );
    expect(original?.revisions).toEqual(receipt?.revisions);
    expect(original?.removedFiles).toBe(4);
  } finally {
    f.close();
    rmSync(copied, { force: true, recursive: true });
  }
});

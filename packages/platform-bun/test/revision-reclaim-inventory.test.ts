import { expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { digestOf } from "../src/application-bundle.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { inventoryReclaimRevisions } from "../src/revision-reclaim-inventory.ts";

function fixture() {
  const root = mkdtempSync(
    path.join(tmpdir(), "effectory-revision-inventory-")
  );
  const directory = path.join(root, ".effectory", "revisions");
  mkdirSync(directory, { recursive: true });
  const add = (index: number, format: 2 | 3 = 3) => {
    // Importing this bundle would fail; inventory must only inspect its bytes.
    const source = `throw new Error("must not import archived bundle ${index}");`;
    const manifest = {
      digest: digestOf(source),
      effectVersion: "0.0.0-archived",
      ...(format === 3 ? { executionContract: "archived/test" } : {}),
      extensionDigests: [],
      format,
      hostAbi: "f".repeat(64),
    };
    const revision = digestOf(`${manifest.hostAbi}/${manifest.digest}`);
    const location = path.join(directory, revision);
    mkdirSync(location);
    writeFileSync(path.join(location, "application.mjs"), source);
    writeFileSync(
      path.join(location, "manifest.json"),
      JSON.stringify(manifest)
    );
    return { location, manifest, revision, source };
  };
  return {
    add,
    directory,
    root,
    run: () =>
      Effect.runPromise(
        inventoryReclaimRevisions(root).pipe(
          Effect.provide(ownershipLayer(path.join(root, ".effectory", "owner")))
        )
      ),
  };
}

test("reclamation inventory inspects archived bundles without loading code or removing incomplete preparations", async () => {
  const f = fixture();
  try {
    const a = f.add(1, 2);
    const b = f.add(2);
    const incomplete = path.join(f.directory, "e".repeat(64));
    mkdirSync(incomplete);
    writeFileSync(path.join(incomplete, "application.mjs"), "incomplete");
    // External hard links retain physical blocks and are not extra bundle files.
    linkSync(
      path.join(a.location, "application.mjs"),
      path.join(f.root, "external-link")
    );
    const before = readFileSync(path.join(a.location, "manifest.json"));
    const rows = await f.run();
    expect(rows.map((r) => r.revision)).toEqual(
      [a.revision, b.revision].toSorted()
    );
    expect(
      rows.find((r) => r.revision === a.revision)?.executionContract
    ).toBeNull();
    expect(rows.find((r) => r.revision === b.revision)?.executionContract).toBe(
      "archived/test"
    );
    expect(rows.find((r) => r.revision === a.revision)?.bytes).toBe(
      before.length + Buffer.byteLength(a.source)
    );
    expect(existsSync(incomplete)).toBe(true);
    expect(readFileSync(path.join(a.location, "manifest.json"))).toEqual(
      before
    );
    expect(readFileSync(path.join(f.root, "external-link"), "utf-8")).toBe(
      a.source
    );
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

test.each(["extra", "symlink", "changed", "format"] as const)(
  "reclamation inventory refuses %s without changing retained files",
  async (kind) => {
    const f = fixture();
    try {
      const a = f.add(1);
      const bundle = path.join(a.location, "application.mjs");
      if (kind === "extra") {
        writeFileSync(path.join(a.location, "unexpected"), "keep");
      }
      if (kind === "symlink") {
        const external = path.join(f.root, "external");
        writeFileSync(external, a.source);
        rmSync(bundle);
        symlinkSync(external, bundle);
      }
      if (kind === "changed") {
        writeFileSync(bundle, "altered");
      }
      if (kind === "format") {
        writeFileSync(
          path.join(a.location, "manifest.json"),
          JSON.stringify({ ...a.manifest, format: 99 })
        );
      }
      await expect(f.run()).rejects.toMatchObject({
        code: "RevisionUnavailable",
      });
      expect(existsSync(a.location)).toBe(true);
      expect(readFileSync(bundle, "utf-8")).toBe(
        kind === "changed" ? "altered" : a.source
      );
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }
);

test("reclamation inventory includes all 128 retained revisions and refuses an over-limit store", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 128; i += 1) {
      f.add(i);
    }
    expect(await f.run()).toHaveLength(128);
    f.add(128);
    await expect(f.run()).rejects.toMatchObject({ code: "LimitExceeded" });
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

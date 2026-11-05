import { expect, test } from "bun:test";
import { gunzipSync, gzipSync } from "node:zlib";

import { extensionLimits } from "@effectory/runtime/extension-protocol";

import {
  digest,
  unpackArchive,
  verifyArchive,
} from "../src/extension-archive.ts";
import {
  archiveFixture,
  fixtureFiles,
  fixtureManifest,
} from "./fixtures/extension-archive.ts";

function modifiedHeader(archive: Uint8Array, change: (header: Buffer) => void) {
  const bytes = gunzipSync(archive);
  const header = bytes.subarray(0, 512);
  change(header);
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return gzipSync(bytes);
}

test("a ustar release verifies static metadata without executing either module", async () => {
  const archive = await archiveFixture();
  const result = verifyArchive(archive, digest(archive));
  expect(result.manifest.id).toBe("acme/tools");
  expect(result.files.size).toBe(5);
  expect(result.manifestDigest).toBe(digest(JSON.stringify(fixtureManifest)));
  expect(() => verifyArchive(archive, "f".repeat(64))).toThrow("digest");
});

test("release verification rejects changed files, unexpected files, missing types and incompatible peers", async () => {
  const modified = await archiveFixture(fixtureManifest, {
    ...fixtureFiles,
    "extension.mjs": "export default {};",
  });
  expect(() => verifyArchive(modified)).toThrow("modified");
  const extra = await archiveFixture(fixtureManifest, {
    ...fixtureFiles,
    "unexpected.js": "",
  });
  expect(() => verifyArchive(extra)).toThrow("unexpected");
  const types = await archiveFixture({
    ...fixtureManifest,
    contracts: { ...fixtureManifest.contracts, types: "missing.d.mts" },
  });
  expect(() => verifyArchive(types)).toThrow("matching .d.mts");
  const incompatible = await archiveFixture({
    ...fixtureManifest,
    effectVersion: "99.0.0",
  });
  expect(() => verifyArchive(incompatible)).toThrow("incompatible");
  const peers = await archiveFixture({
    ...fixtureManifest,
    dependencyInventory: [{ name: "effect", version: "4.0.5" }],
  });
  expect(() => verifyArchive(peers)).toThrow("cannot be bundled");
});

test("archive validation rejects links, traversal, absolute paths, truncation and expansion bombs", async () => {
  const archive = await archiveFixture();
  for (const type of [49, 50, 120, 103]) {
    expect(() =>
      unpackArchive(
        modifiedHeader(archive, (header) => {
          header[156] = type;
        })
      )
    ).toThrow("Only regular files");
  }
  for (const name of [
    "../escape.mjs",
    "/absolute.mjs",
    "node_modules/effect/index.mjs",
  ]) {
    const modified = modifiedHeader(archive, (header) => {
      header.fill(0, 0, 100);
      header.write(name, 0, "ascii");
    });
    expect(() => unpackArchive(modified)).toThrow("without traversal");
  }
  const truncated = gzipSync(gunzipSync(archive).subarray(0, 600));
  expect(() => unpackArchive(truncated)).toThrow("Truncated");
  expect(() =>
    unpackArchive(new Uint8Array(extensionLimits.archiveBytes + 1))
  ).toThrow("Compressed extension");
  const bomb = gzipSync(new Uint8Array(extensionLimits.expandedBytes + 1));
  expect(() => unpackArchive(bomb)).toThrow("expansion exceeds");
});

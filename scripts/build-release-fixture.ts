import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyArchive } from "../packages/platform-bun/src/extension-archive.ts";
import { publishedExtension } from "../packages/platform-bun/test/fixtures/published-extension.ts";

const temporary = await mkdtemp(
  path.join(tmpdir(), "effectory-release-fixture-")
);
const destination = path.resolve("dist/release-fixture");
try {
  const built = await publishedExtension(path.join(temporary, "publisher"));
  const verified = verifyArchive(built.archive);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "effectory.tgz"), built.archive);
  await writeFile(
    path.join(destination, "manifest.json"),
    `${JSON.stringify(built.manifest, null, 2)}\n`
  );
  await writeFile(
    path.join(destination, "sha256.txt"),
    `${verified.archiveDigest}  effectory.tgz\n`
  );
  console.log(
    JSON.stringify({
      archive: path.join(destination, "effectory.tgz"),
      bytes: built.archive.length,
      extensionId: built.manifest.id,
      sha256: verified.archiveDigest,
    })
  );
} finally {
  await rm(temporary, { force: true, recursive: true });
}

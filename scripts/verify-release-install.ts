import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Schema } from "effect";

import { runBounded } from "../packages/platform-bun/src/bounded-process.ts";
import { parseSource } from "../packages/platform-bun/src/extension-source.ts";
import {
  cli,
  effectory,
  operation,
  start,
} from "../packages/platform-bun/test/fixtures/cli.ts";
import {
  ExtensionInventory,
  ExtensionOperation,
} from "../packages/runtime/src/extension-protocol.ts";
import { OperationError, Run } from "../packages/runtime/src/protocol.ts";

const [source, asset, trust] = process.argv.slice(2);
if (!source || !asset || trust !== "--trust-fixture") {
  throw new Error(
    "Usage: bun scripts/verify-release-install.ts github:owner/repository@tag effectory.tgz --trust-fixture (executes the published fixture/tools extension)"
  );
}
parseSource(source, asset);
const directory = await mkdtemp(path.join(tmpdir(), "effectory-live-install-"));
const repository = path.join(directory, "consumer");
const children: Awaited<ReturnType<typeof start>>[] = [];
try {
  await mkdir(repository);
  await writeFile(
    path.join(repository, "effectory.ts"),
    'import { Application } from "@effectory/core"; export default Application.make({});'
  );
  const first = await start(repository);
  children.push(first);
  const accepted = Schema.decodeUnknownSync(ExtensionOperation)(
    await cli(repository, [
      "extension",
      "add",
      source,
      "--asset",
      asset,
      "--as",
      "Tools",
      "--trust",
    ])
  );
  const settled = await operation(repository, accepted.operationId);
  assert.equal(settled.status, "Succeeded", JSON.stringify(settled.error));
  const inventory = Schema.decodeUnknownSync(ExtensionInventory)(
    await cli(repository, ["extension", "list"])
  );
  const installed = inventory.extensions.find(
    (entry) => entry.id === "fixture/tools"
  );
  assert.ok(
    installed,
    "Expected the fixture/tools release archive produced by build-release-fixture.ts"
  );
  assert.equal(
    installed.selected,
    false,
    "Installation must not select contributions"
  );
  assert.equal(installed.bindingName, "Tools");
  await cli(repository, ["daemon", "stop", "--grace-period-ms", "0"]);
  await first.exited;

  // Compile the normal consumer against generated typed imports on restart.
  await writeFile(
    path.join(repository, "effectory.ts"),
    await readFile(
      path.resolve(
        import.meta.dir,
        "../packages/platform-bun/test/fixtures/published-extension/consumer.txt"
      ),
      "utf-8"
    )
  );
  const selected = await start(repository);
  children.push(selected);
  const before = Schema.decodeUnknownSync(Run)(
    await cli(repository, [
      "workflow",
      "run",
      "local/flow",
      "--input",
      '{"repository":"a/b"}',
    ])
  );
  assert.equal(before.status, "Succeeded");
  assert.equal(before.result, "formatted:loaded/a/b");
  await cli(repository, ["daemon", "stop", "--grace-period-ms", "0"]);
  await selected.exited;

  // Make every gh invocation fail and record it. This checks an offline cache
  // restore, not a network sandbox for privileged application code.
  const offlineBin = path.join(directory, "offline-bin");
  const attempted = path.join(directory, "unexpected-gh-call");
  await mkdir(offlineBin);
  await writeFile(
    path.join(offlineBin, "gh"),
    `#!${process.execPath}\nawait Bun.write(${JSON.stringify(attempted)}, "attempted"); process.exit(77);\n`,
    { mode: 0o700 }
  );
  const offline = {
    ...process.env,
    PATH: `${offlineBin}:${process.env.PATH ?? ""}`,
  };
  await Effect.runPromise(
    runBounded(
      [
        ...effectory,
        "extension",
        "restore",
        "--repository",
        repository,
        "--json",
      ],
      {
        environment: offline,
        failure: () =>
          new OperationError({
            code: "Unavailable",
            message: "Offline CLI restore failed",
          }),
        maximumBytes: 1_048_576,
      }
    )
  );
  children.push(await start(repository, offline));
  const after = Schema.decodeUnknownSync(Run)(
    await cli(repository, [
      "workflow",
      "run",
      "local/flow",
      "--input",
      '{"repository":"a/b"}',
    ])
  );
  assert.equal(after.status, "Succeeded");
  assert.equal(after.result, before.result);
  assert.equal(after.revision, before.revision);
  assert.equal(
    await Bun.file(attempted).exists(),
    false,
    "Offline restore/startup tried GitHub"
  );
  console.log(
    JSON.stringify({
      assetId: installed.source.assetId,
      digest: installed.digest,
      extensionId: installed.id,
      offlineRestore: true,
      releaseId: installed.source.releaseId,
      result: after.result,
      source: installed.source.repository,
      version: installed.version,
    })
  );
} finally {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    })
  );
  await rm(directory, { force: true, recursive: true });
}

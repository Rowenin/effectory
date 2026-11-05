import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { extensionLimits } from "@effectory/runtime/extension-protocol";

import { assertTrusted } from "./extension-bindings.ts";
import { packagePath, validateLock, verifyCached } from "./extension-cache.ts";
import { validateExports } from "./extension-validation.ts";
import { installHostModules } from "./host-runtime.ts";

// This process isolates validation failure/cancellation, not privileged code.
async function main(
  repository: string | undefined,
  filename: string | undefined
) {
  if (!repository || !filename) {
    throw new Error("Validation input is missing");
  }
  const stat = lstatSync(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > extensionLimits.lockBytes
  ) {
    throw new Error("Validation snapshot is invalid");
  }
  const lock = validateLock(JSON.parse(readFileSync(filename, "utf-8")));
  assertTrusted(repository, lock);
  installHostModules();
  // Every module is verified before importing the first one, including shared
  // contract dependencies reached transitively from a selected entry point.
  for (const locked of Object.values(lock.packages)) {
    verifyCached(repository, locked);
  }
  for (const locked of Object.values(lock.packages)) {
    const contractsUrl = pathToFileURL(
      path.join(packagePath(repository, locked), locked.manifest.contracts.file)
    ).href;
    const implementationUrl = pathToFileURL(
      path.join(
        packagePath(repository, locked),
        locked.manifest.entrypoint.file
      )
    ).href;
    // oxlint-disable-next-line no-await-in-loop -- Validate bounded package modules sequentially.
    const contracts: unknown = await import(contractsUrl);
    // oxlint-disable-next-line no-await-in-loop -- Implementation follows its canonical contract import.
    const implementation: unknown = await import(implementationUrl);
    // oxlint-disable-next-line no-await-in-loop -- Validation belongs to the just-imported package.
    await validateExports(
      locked.manifest,
      contracts,
      implementation,
      locked.archiveDigest
    );
  }
  process.stdout.write(JSON.stringify({ valid: true }));
}
/** Entry point for `[repository, lockSnapshot]`; reports through stdout and the exit code. */
export async function runValidationWorker(args: readonly string[]) {
  try {
    await main(args.at(0), args.at(1));
  } catch {
    process.exitCode = 1;
  }
}
if (import.meta.main) {
  await runValidationWorker(process.argv.slice(2));
}

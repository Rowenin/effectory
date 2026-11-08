import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { Digest } from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { digestOf } from "./application-bundle.ts";

const fields = {
  digest: Digest,
  effectVersion: Schema.String.check(Schema.isMaxLength(64)),
  extensionDigests: Schema.Array(Digest).check(Schema.isMaxLength(128)),
  hostAbi: Digest,
};

export const LegacyRevisionManifest = Schema.Struct({
  ...fields,
  format: Schema.Literal(2),
});
export const ContractRevisionManifest = Schema.Struct({
  ...fields,
  executionContract: Schema.String.check(
    Schema.isPattern(/^[a-z0-9][a-z0-9./-]{0,127}$/u)
  ),
  format: Schema.Literal(3),
});
/** Decoding metadata never grants execution compatibility. */
export const RevisionManifest = Schema.Union([
  LegacyRevisionManifest,
  ContractRevisionManifest,
]);

function file(filename: string, maximum: number) {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.size > maximum) {
    throw new Error("Invalid retained revision file");
  }
  return readFileSync(filename);
}

/** No imports, Layer acquisition, or deletion of incomplete revision directories. */
export function inspectRevisionManifests(repository: string) {
  const directory = path.join(repository, ".effectory", "revisions");
  let entries: string[];
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory()) {
      throw new Error("Invalid retained revision directory");
    }
    entries = readdirSync(directory);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      Reflect.get(error, "code") === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  const names = entries
    .filter((name) => /^[a-f0-9]{64}$/u.test(name))
    .toSorted();
  if (names.length > 256) {
    throw new OperationError({
      code: "LimitExceeded",
      message: "Application revision directory limit reached",
    });
  }
  const result: {
    readonly revision: string;
    readonly manifest: typeof RevisionManifest.Type;
  }[] = [];
  for (const revision of names) {
    const location = path.join(directory, revision);
    if (!lstatSync(location).isDirectory()) {
      throw new Error("Invalid retained revision directory");
    }
    let bytes: Buffer;
    try {
      bytes = file(path.join(location, "manifest.json"), 65_536);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        Reflect.get(error, "code") === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    const manifest = Schema.decodeUnknownSync(RevisionManifest)(
      JSON.parse(bytes.toString("utf-8")),
      { onExcessProperty: "error" }
    );
    if (
      digestOf(`${manifest.hostAbi}/${manifest.digest}`) !== revision ||
      digestOf(file(path.join(location, "application.mjs"), 16_777_216)) !==
        manifest.digest
    ) {
      throw new Error("Retained revision integrity mismatch");
    }
    result.push({ manifest, revision });
  }
  if (result.length > 128) {
    throw new OperationError({
      code: "LimitExceeded",
      message: "Retained application revision limit reached (128)",
    });
  }
  return result;
}

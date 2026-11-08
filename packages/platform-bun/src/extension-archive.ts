import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import {
  ExtensionManifest,
  extensionLimits,
} from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Schema } from "effect";

export const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const invalid = (message: string) =>
  new OperationError({ code: "InvalidInput", message });
const limit = (message: string) =>
  new OperationError({ code: "LimitExceeded", message });

export function archivePath(value: string): string {
  if (
    value.length > 200 ||
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value) ||
    value
      .split("/")
      .some((part) => part === "." || part === ".." || part === "node_modules")
  ) {
    throw invalid(
      "Archive paths must be bounded relative paths without traversal or node_modules"
    );
  }
  return value;
}
function textField(header: Uint8Array, offset: number, length: number): string {
  const bytes = header.subarray(offset, offset + length);
  const zero = bytes.indexOf(0);
  const field = zero === -1 ? bytes : bytes.subarray(0, zero);
  if (zero !== -1 && bytes.subarray(zero).some((byte) => byte !== 0)) {
    throw invalid("Archive field has nonzero bytes after its terminator");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(field);
}
function octal(header: Uint8Array, offset: number, length: number): number {
  const text = new TextDecoder()
    .decode(header.subarray(offset, offset + length))
    .replace(/[\0 ]+$/u, "")
    .trim();
  if (!/^[0-7]+$/u.test(text)) {
    throw invalid("Invalid archive numeric field");
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw invalid("Unsafe archive numeric field");
  }
  return value;
}
function headerPath(header: Uint8Array): string {
  if (
    textField(header, 257, 6) !== "ustar" ||
    textField(header, 263, 2) !== "00"
  ) {
    throw invalid("Extension archives must use the bounded ustar format");
  }
  const checksum = octal(header, 148, 8);
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  if (sum !== checksum) {
    throw invalid("Archive header checksum mismatch");
  }
  const prefix = textField(header, 345, 155);
  const name = textField(header, 0, 100);
  return prefix ? `${prefix}/${name}` : name;
}

/** Decode bytes only. No archive entry or manifest code is executed. */
export function unpackArchive(
  compressed: Uint8Array
): ReadonlyMap<string, Uint8Array> {
  if (compressed.byteLength > extensionLimits.archiveBytes) {
    throw limit("Compressed extension exceeds 16 MiB");
  }
  let bytes: Uint8Array;
  try {
    bytes = gunzipSync(compressed, {
      maxOutputLength: extensionLimits.expandedBytes,
    });
  } catch {
    throw invalid("Invalid gzip archive or expansion exceeds 64 MiB");
  }
  const files = new Map<string, Uint8Array>();
  const paths = new Set<string>();
  let position = 0;
  while (position + 512 <= bytes.length) {
    const header = bytes.subarray(position, position + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        position + 1024 > bytes.length ||
        bytes.subarray(position).some((byte) => byte !== 0)
      ) {
        throw invalid(
          "Archive must end with two zero blocks and no trailing data"
        );
      }
      return files;
    }
    const rawPath = headerPath(header);
    // oxlint-disable-next-line prefer-destructuring -- Read the ustar type byte at its fixed offset.
    const type = header[156];
    if (type !== 0 && type !== 48 && type !== 53) {
      throw invalid(
        "Only regular files and directories are allowed in extension archives"
      );
    }
    const name = archivePath(
      type === 53 ? rawPath.replace(/\/$/u, "") : rawPath
    );
    if (paths.has(name) || paths.size >= extensionLimits.files) {
      throw invalid("Duplicate archive path or more than 512 entries");
    }
    paths.add(name);
    const size = octal(header, 124, 12);
    if (type === 53 && size !== 0) {
      throw invalid("Archive directories cannot contain data");
    }
    const end = position + 512 + size;
    const next = position + 512 + Math.ceil(size / 512) * 512;
    if (end > bytes.length || next > bytes.length) {
      throw invalid("Truncated archive entry");
    }
    if (type !== 53) {
      files.set(name, bytes.slice(position + 512, end));
    }
    position = next;
  }
  throw invalid("Archive end marker is missing");
}

function validateProviderIds(manifest: typeof ExtensionManifest.Type) {
  for (const kind of ["implementations", "patches"] as const) {
    const contributions = manifest.contributions[kind];
    if (
      new Set(contributions.map((entry) => entry.id)).size !==
      contributions.length
    ) {
      throw invalid(`Duplicate ${kind} IDs`);
    }
  }
}

const manifestLists = (manifest: typeof ExtensionManifest.Type, file: string) =>
  (manifest.files[file] ?? "") !== "";

export function validateManifest(manifest: typeof ExtensionManifest.Type) {
  const names = Object.keys(manifest.files);
  if (
    names.length > extensionLimits.files - 1 ||
    Object.keys(manifest.dependencies).length > 32
  ) {
    throw limit("Extension manifest exceeds file or dependency limits");
  }
  for (const filename of names) {
    archivePath(filename);
  }
  for (const entry of [manifest.entrypoint, manifest.contracts]) {
    archivePath(entry.file);
    archivePath(entry.types);
    if (
      !entry.file.endsWith(".mjs") ||
      entry.types !== entry.file.replace(/\.mjs$/u, ".d.mts") ||
      !manifestLists(manifest, entry.file) ||
      !manifestLists(manifest, entry.types)
    ) {
      throw invalid(
        "Each extension entry needs an ESM file and matching .d.mts declarations"
      );
    }
  }
  if (manifest.entrypoint.file === manifest.contracts.file) {
    throw invalid("Contracts must have a separate entry point");
  }
  for (const name of Object.keys(manifest.dependencies)) {
    if (
      name === "effect" ||
      name.startsWith("@effect/") ||
      name.startsWith("@effectory/") ||
      name === "@offtree/effectory-sdk"
    ) {
      throw invalid("Host peer libraries cannot be extension dependencies");
    }
  }
  if (
    manifest.dependencyInventory.some(
      (entry) =>
        entry.name === "effect" ||
        entry.name.startsWith("@effect/") ||
        entry.name.startsWith("@effectory/") ||
        entry.name === "@offtree/effectory-sdk"
    )
  ) {
    throw invalid("Host peer libraries cannot be bundled");
  }
  validateProviderIds(manifest);
  for (const kind of ["tasks", "workflows", "artifacts"] as const) {
    const contributions = manifest.contributions[kind];
    if (
      new Set(contributions.map((entry) => entry.name)).size !==
        contributions.length ||
      new Set(contributions.map((entry) => entry.id)).size !==
        contributions.length
    ) {
      throw invalid(`Duplicate ${kind} exports`);
    }
    if (
      contributions.some((entry) =>
        ["__proto__", "prototype", "constructor"].includes(entry.name)
      )
    ) {
      throw invalid(`Reserved ${kind} export`);
    }
  }
}
export function verifyArchive(compressed: Uint8Array, expectedDigest?: string) {
  const archiveDigest = digest(compressed);
  if (expectedDigest !== undefined && archiveDigest !== expectedDigest) {
    throw invalid("Extension archive digest disagrees with its lock");
  }
  const files = unpackArchive(compressed);
  const bytes = files.get("effectory.extension.json");
  if (!bytes || bytes.length > extensionLimits.manifestBytes) {
    throw invalid("A bounded effectory.extension.json manifest is required");
  }
  let manifest: typeof ExtensionManifest.Type;
  try {
    manifest = Schema.decodeUnknownSync(ExtensionManifest)(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      { onExcessProperty: "error" }
    );
  } catch {
    throw invalid(
      "Extension manifest is invalid or requires an incompatible SDK/Effect version"
    );
  }
  validateManifest(manifest);
  const listed = Object.keys(manifest.files);
  if (
    files.size !== listed.length + 1 ||
    listed.includes("effectory.extension.json") ||
    listed.includes("package.json")
  ) {
    throw invalid("Archive contains unexpected files or reserved metadata");
  }
  for (const name of listed) {
    const value = files.get(name);
    if (!value || digest(value) !== manifest.files[name]) {
      throw invalid(`Missing or modified extension file: ${name}`);
    }
  }
  // Reject file/directory prefix collisions before materializing anything.
  for (const name of files.keys()) {
    const segments = name.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (files.has(segments.slice(0, index).join("/"))) {
        throw invalid("Archive file/directory collision");
      }
    }
  }
  return {
    archiveBytes: compressed.byteLength,
    archiveDigest,
    files,
    manifest,
    manifestDigest: digest(bytes),
  };
}

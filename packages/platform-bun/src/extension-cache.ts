import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  readlinkSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import path from "node:path";

import { canonical, encode } from "@effectory/core/internal/boundary";
import type { LockedPackage } from "@effectory/runtime/extension-protocol";
import {
  ExtensionLock,
  ExtensionManifest,
  extensionLimits,
} from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import {
  archivePath,
  digest,
  validateManifest,
  verifyArchive,
} from "./extension-archive.ts";
import { ExtensionSource } from "./extension-source.ts";
import { RepositoryLease } from "./ownership.ts";

export const emptyLock: typeof ExtensionLock.Type = Object.freeze({
  format: 1,
  packages: {},
  roots: {},
});
export const lockRevision = (lock: typeof ExtensionLock.Type) =>
  digest(canonical(encode(ExtensionLock, lock)));
const invalid = (message: string) =>
  new OperationError({ code: "InvalidInput", message });
const diskError = (cause: unknown) =>
  cause instanceof OperationError
    ? cause
    : new OperationError({
        code: "Unavailable",
        message:
          "Extension cache could not be read or written; check disk space and repository permissions",
      });
const objectPath = (repository: string, hash: string) =>
  path.join(repository, ".effectory", "extensions", "objects", hash);
export const packagePath = (
  repository: string,
  locked: typeof LockedPackage.Type
) => path.join(objectPath(repository, locked.archiveDigest), "package");
const reserved = new Set(
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield eval arguments __proto__ constructor prototype".split(
    " "
  )
);
export function bindingName(value: string): string {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/u.test(value) || reserved.has(value)) {
    throw invalid(
      "Extension binding name must be a nonreserved JavaScript identifier"
    );
  }
  return value;
}

export function validateLock(value: unknown): typeof ExtensionLock.Type {
  const lock = Schema.decodeUnknownSync(ExtensionLock)(value, {
    onExcessProperty: "error",
  });
  if (
    Object.keys(lock.packages).length > extensionLimits.packages ||
    Object.keys(lock.roots).length > extensionLimits.packages
  ) {
    throw invalid("An extension lock supports at most 128 packages");
  }
  for (const locked of Object.values(lock.packages)) {
    validateManifest(locked.manifest);
    if (
      locked.source.publisherDigest !== null &&
      locked.source.publisherDigest !== locked.archiveDigest
    ) {
      throw invalid("Publisher digest disagrees with the locked archive");
    }
  }
  const aliases = new Set<string>();
  for (const [id, root] of Object.entries(lock.roots)) {
    const locked = lock.packages[id];
    if (
      !locked ||
      locked.manifest.id !== id ||
      root.source.repository !== locked.source.repository ||
      root.source.ref !== locked.source.ref ||
      root.source.assetName !== locked.source.assetName
    ) {
      throw invalid(`Root and locked package disagree: ${id}`);
    }
    if (root.bindingName !== undefined) {
      bindingName(root.bindingName);
      if (aliases.has(root.bindingName)) {
        throw invalid(`Duplicate extension binding: ${root.bindingName}`);
      }
      aliases.add(root.bindingName);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw invalid(`Extension dependency cycle: ${id}`);
    }
    const locked = lock.packages[id];
    if (!locked || locked.manifest.id !== id) {
      throw invalid(`Missing locked dependency: ${id}`);
    }
    const dependencyNames = Object.keys(locked.dependencies).toSorted();
    if (
      JSON.stringify(dependencyNames) !==
      JSON.stringify(Object.keys(locked.manifest.dependencies).toSorted())
    ) {
      throw invalid(`Dependency declaration disagrees with lock: ${id}`);
    }
    visiting.add(id);
    for (const name of dependencyNames) {
      const targetId = locked.dependencies[name];
      const target =
        targetId === undefined ? undefined : lock.packages[targetId];
      const requested = locked.manifest.dependencies[name];
      if (
        !target ||
        !requested ||
        requested.repository !== target.source.repository ||
        requested.ref !== target.source.ref ||
        requested.assetName !== target.source.assetName
      ) {
        throw invalid(`Dependency source disagrees with lock: ${id}/${name}`);
      }
      visit(target.manifest.id);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of Object.keys(lock.roots)) {
    visit(id);
  }
  if (visited.size !== Object.keys(lock.packages).length) {
    throw invalid("Extension lock contains unreachable packages");
  }
  return lock;
}

function durableFile(filename: string, bytes: Uint8Array | string) {
  writeFileSync(filename, bytes, { flag: "wx", mode: 0o400 });
  const file = openSync(filename, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}
function syncDirectory(directory: string) {
  const file = openSync(directory, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}
function metadata(locked: typeof LockedPackage.Type) {
  return JSON.stringify({
    exports: {
      ".": {
        import: `./${locked.manifest.contracts.file}`,
        types: `./${locked.manifest.contracts.types}`,
      },
    },
    name: `@effectory-extension/${locked.archiveDigest}`,
    private: true,
    type: "module",
  });
}
function regularFile(filename: string, maximum: number) {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) {
    throw invalid("Extension cache contains an unexpected file type or size");
  }
  return readFileSync(filename);
}
function verifyManifest(
  archive: ReturnType<typeof verifyArchive>,
  locked: typeof LockedPackage.Type
) {
  if (
    archive.archiveBytes !== locked.source.size ||
    archive.manifestDigest !== locked.manifestDigest ||
    canonical(encode(ExtensionManifest, locked.manifest)) !==
      canonical(encode(ExtensionManifest, archive.manifest))
  ) {
    throw invalid("Cached extension manifest disagrees with its lock");
  }
}

function verifyFiles(
  directory: string,
  expected: ReadonlyMap<string, Uint8Array>,
  prefix = ""
): void {
  for (const name of readdirSync(directory)) {
    if (!prefix && (name === "node_modules" || name === "package.json")) {
      continue;
    }
    const filename = path.join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(filename);
    if (stat.isSymbolicLink()) {
      throw invalid(
        "Extension cache contains a symbolic link outside dependency wiring"
      );
    }
    if (stat.isDirectory()) {
      verifyFiles(filename, expected, relative);
      continue;
    }
    const bytes = expected.get(relative);
    if (
      !bytes ||
      stat.size !== bytes.length ||
      digest(regularFile(filename, bytes.length)) !== digest(bytes)
    ) {
      throw invalid(`Modified extension cache file: ${relative}`);
    }
  }
  if (prefix === "") {
    for (const [name, bytes] of expected) {
      if (
        digest(regularFile(path.join(directory, name), bytes.length)) !==
        digest(bytes)
      ) {
        throw invalid(`Missing or modified cached file: ${name}`);
      }
    }
  }
}
export function verifyCached(
  repository: string,
  locked: typeof LockedPackage.Type
) {
  const directory = objectPath(repository, locked.archiveDigest);
  if (
    !lstatSync(directory).isDirectory() ||
    lstatSync(directory).isSymbolicLink()
  ) {
    throw invalid("Extension cache object is not a regular directory");
  }
  const archive = verifyArchive(
    regularFile(
      path.join(directory, "archive.tgz"),
      extensionLimits.archiveBytes
    ),
    locked.archiveDigest
  );
  verifyManifest(archive, locked);
  const location = packagePath(repository, locked);
  if (
    !lstatSync(location).isDirectory() ||
    lstatSync(location).isSymbolicLink()
  ) {
    throw invalid("Extension package is not a regular directory");
  }
  verifyFiles(location, archive.files);
  if (
    regularFile(path.join(location, "package.json"), 4096).toString() !==
    metadata(locked)
  ) {
    throw invalid("Generated extension package metadata was modified");
  }
  return archive;
}

/** Stores verified bytes atomically. It never evaluates a package module. */
export function cacheArchive(
  repository: string,
  locked: typeof LockedPackage.Type,
  compressed: Uint8Array
) {
  const archive = verifyArchive(compressed, locked.archiveDigest);
  verifyManifest(archive, locked);
  const destination = objectPath(repository, locked.archiveDigest);
  if (existsSync(destination)) {
    return verifyCached(repository, locked);
  }
  const parent = path.dirname(destination);
  mkdirSync(parent, { mode: 0o700, recursive: true });
  const staging = path.join(parent, `.staging-${crypto.randomUUID()}`);
  const directory = path.join(staging, "package");
  mkdirSync(directory, { mode: 0o700, recursive: true });
  try {
    for (const [name, bytes] of archive.files) {
      archivePath(name);
      const filename = path.join(directory, name);
      mkdirSync(path.dirname(filename), { mode: 0o700, recursive: true });
      durableFile(filename, bytes);
      syncDirectory(path.dirname(filename));
    }
    durableFile(path.join(directory, "package.json"), metadata(locked));
    durableFile(path.join(staging, "archive.tgz"), compressed);
    const directories = new Set([directory]);
    for (const name of archive.files.keys()) {
      let parentDirectory = path.dirname(path.join(directory, name));
      while (parentDirectory !== directory) {
        directories.add(parentDirectory);
        parentDirectory = path.dirname(parentDirectory);
      }
    }
    for (const parentDirectory of directories) {
      syncDirectory(parentDirectory);
    }
    syncDirectory(staging);
    renameSync(staging, destination);
    syncDirectory(parent);
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
  return archive;
}

function ensureDirectory(directory: string) {
  if (
    existsSync(directory) &&
    (!lstatSync(directory).isDirectory() ||
      lstatSync(directory).isSymbolicLink())
  ) {
    throw invalid("Extension dependency directory was replaced");
  }
  mkdirSync(directory, { mode: 0o700, recursive: true });
}
function verifyDependencyLinks(
  directory: string,
  expected: ReadonlyMap<string, string>,
  prefix = ""
): void {
  for (const name of readdirSync(directory)) {
    const key = `${prefix}${name}`;
    const filename = path.join(directory, name);
    const target = expected.get(key);
    if (target !== undefined) {
      if (
        !lstatSync(filename).isSymbolicLink() ||
        readlinkSync(filename) !== target
      ) {
        throw invalid("Extension dependency link disagrees with its lock");
      }
    } else if (
      prefix === "" &&
      name.startsWith("@") &&
      [...expected.keys()].some((item) => item.startsWith(`${name}/`))
    ) {
      ensureDirectory(filename);
      verifyDependencyLinks(filename, expected, `${name}/`);
    } else {
      throw invalid("Unexpected module in the extension dependency directory");
    }
  }
}
function wireDependencies(repository: string, lock: typeof ExtensionLock.Type) {
  for (const locked of Object.values(lock.packages)) {
    const modules = path.join(packagePath(repository, locked), "node_modules");
    ensureDirectory(modules);
    const expected = new Map<string, string>();
    for (const [name, id] of Object.entries(locked.dependencies)) {
      const target = lock.packages[id];
      if (!target) {
        throw invalid("Locked dependency is missing");
      }
      expected.set(
        name,
        path.relative(
          path.dirname(path.join(modules, name)),
          packagePath(repository, target)
        )
      );
    }
    verifyDependencyLinks(modules, expected);
    for (const [name, target] of expected) {
      const link = path.join(modules, name);
      ensureDirectory(path.dirname(link));
      if (!existsSync(link)) {
        symlinkSync(target, link, "dir");
      }
      syncDirectory(path.dirname(link));
    }
    syncDirectory(modules);
    syncDirectory(packagePath(repository, locked));
  }
}

/** Offline cache hits do not contact GitHub or resolve mutable tags. */
export function restoreCache(
  repository: string,
  snapshot: typeof ExtensionLock.Type
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const source = yield* ExtensionSource;
    const lock = yield* Effect.try({
      catch: diskError,
      try: () => validateLock(snapshot),
    });
    for (const locked of Object.values(lock.packages)) {
      const cached = yield* Effect.try({
        catch: diskError,
        try: () => {
          lease.assertActive();
          if (!existsSync(objectPath(repository, locked.archiveDigest))) {
            return false;
          }
          verifyCached(repository, locked);
          return true;
        },
      });
      if (cached) {
        continue;
      }
      const bytes = yield* source.download(locked.source);
      yield* Effect.try({
        catch: diskError,
        try: () => {
          lease.assertActive();
          cacheArchive(repository, locked, bytes);
        },
      });
    }
    yield* Effect.try({
      catch: diskError,
      try: () => {
        lease.assertActive();
        wireDependencies(repository, lock);
      },
    });
    return lock;
  });
}

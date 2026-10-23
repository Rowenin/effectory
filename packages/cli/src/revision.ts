/**
 * The collection revision: a SHA-256 over the source graph of the
 * collection root plus the lockfile. A run records it; resuming under a
 * different revision is refused.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

type Loader = "ts" | "tsx" | "js" | "jsx";

const loaders: Readonly<Record<string, Loader>> = {
  ".cjs": "js",
  ".cts": "ts",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".mts": "ts",
  ".ts": "ts",
  ".tsx": "tsx",
};

const transpilers = new Map<Loader, Bun.Transpiler>();

const transpiler = (loader: Loader) => {
  let found = transpilers.get(loader);
  if (found === undefined) {
    found = new Bun.Transpiler({ loader });
    transpilers.set(loader, found);
  }
  return found;
};

const vendored = `${path.sep}node_modules${path.sep}`;

/** Where `specifier` imported from `from` lives, if it is collection source. */
const resolveLocal = (specifier: string, from: string) => {
  let resolved: string;
  try {
    resolved = Bun.resolveSync(specifier, path.dirname(from));
  } catch {
    // Unresolvable imports fail when the collection loads; they add no source.
    return;
  }
  if (!path.isAbsolute(resolved) || !existsSync(resolved)) {
    // Builtins such as `node:fs` and `bun:sqlite`.
    return;
  }
  const real = realpathSync(resolved);
  return real.includes(vendored) ? undefined : real;
};

/** The source files the root imports transitively, excluding `node_modules`. */
export const sourceFiles = (rootFile: string): readonly string[] => {
  const root = realpathSync(rootFile);
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const loader = loaders[path.extname(file)];
    if (loader !== undefined) {
      const imports = transpiler(loader).scanImports(
        readFileSync(file, "utf-8")
      );
      for (const entry of imports) {
        const local = resolveLocal(entry.path, file);
        if (local !== undefined && !seen.has(local)) {
          seen.add(local);
          queue.push(local);
        }
      }
    }
  }
  return [...seen];
};

/** The nearest `bun.lock` in `directory` or its ancestors. */
export const lockfile = (directory: string): string | undefined => {
  let current = path.resolve(directory);
  for (;;) {
    const candidate = path.join(current, "bun.lock");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
};

/**
 * SHA-256 over each source file's path relative to the collection directory
 * and its contents, in path order, then the nearest `bun.lock`.
 */
export const revision = (rootFile: string): string => {
  const base = path.dirname(realpathSync(rootFile));
  const entries = sourceFiles(rootFile)
    .map((file) => ({
      file,
      name: path.relative(base, file).split(path.sep).join("/"),
    }))
    .toSorted((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${entry.name}\0`);
    hash.update(readFileSync(entry.file));
    hash.update("\0");
  }
  const lock = lockfile(base);
  if (lock !== undefined) {
    hash.update("bun.lock\0");
    hash.update(readFileSync(lock));
    hash.update("\0");
  }
  return hash.digest("hex");
};

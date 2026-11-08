import { pathToFileURL } from "node:url";

type ExportKind = "function" | "object" | "string";
type ExportKinds<T> = { readonly [K in keyof T]: ExportKind };

const hasExports = <T extends object>(
  module: unknown,
  kinds: ExportKinds<T>
): module is T =>
  typeof module === "object" &&
  module !== null &&
  Object.entries<ExportKind>(kinds).every(
    ([name, kind]) => typeof Reflect.get(module, name) === kind
  );

/**
 * Imports a generated test module after checking the runtime kind of each
 * export the caller relies on. Identity and behaviour remain the test's job.
 */
export async function importModule<T extends object>(
  filename: string,
  kinds: ExportKinds<T>
): Promise<T> {
  const module: unknown = await import(pathToFileURL(filename).href);
  if (!hasExports(module, kinds)) {
    throw new TypeError(`${filename} does not have the expected exports`);
  }
  return module;
}

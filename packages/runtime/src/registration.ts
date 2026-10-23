import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { effectoryProject, resolveSourceDependency } from "./project.ts";
import { TaskCatalogError } from "./task.ts";

/** Load a validated root registration without inheriting the host's resolver. */
export const importRegistration = async (
  workspace: string,
  entrypoint: string
): Promise<{ default?: unknown }> => {
  const root = realpathSync(workspace);
  const project = effectoryProject(root);
  if (project === root) {
    return import(pathToFileURL(entrypoint).href);
  }
  // Compile only this module. External absolute imports preserve native dependency
  // identity and caching, including the runtime's Effect instance. No files or
  // process-global loader hooks are installed in the host.
  const result = await Bun.build({
    entrypoints: [entrypoint],
    plugins: [
      {
        name: "effectory-registration-imports",
        setup(build) {
          build.onResolve({ filter: /.*/u }, (args) => {
            if (!args.importer) {
              return;
            }
            const specifier = args.path;
            if (specifier.startsWith("node:") || specifier === "bun:sqlite") {
              return { external: true, path: specifier };
            }
            return {
              external: true,
              path:
                specifier.startsWith("./") || specifier.startsWith("../")
                  ? path.resolve(path.dirname(entrypoint), specifier)
                  : resolveSourceDependency(
                      root,
                      project,
                      specifier,
                      entrypoint
                    ),
            };
          });
        },
      },
    ],
    target: "bun",
    throw: false,
    tsconfig: path.join(project, "tsconfig.json"),
  });
  const [output] = result.outputs;
  if (!result.success || !output) {
    throw new TaskCatalogError(
      `Cannot compile ${entrypoint}: ${result.logs.join("\n")}`
    );
  }
  const source = `${await output.text()}\n//# sourceURL=${pathToFileURL(entrypoint).href}\n`;
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
};

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { workspacePaths } from "./paths.ts";

class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  message: string;
}> {}

const WorkspaceConfig = Schema.Struct({
  project: Schema.optional(Schema.Literal(".effectory")),
  version: Schema.Literal(1),
});

// Publish complete JSON without overwriting an existing definition or result.
const writeNewJson = Effect.fn("Workspace.writeNewJson")(function* writeNewJson(
  filename: string,
  value: unknown
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(filename);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* Effect.scoped(
    Effect.gen(function* publishJson() {
      const temporary = yield* fs.makeTempFileScoped({
        directory,
        prefix: ".pending-",
      });
      yield* fs.writeFileString(
        temporary,
        `${JSON.stringify(value, null, 2)}\n`
      );
      yield* fs.link(temporary, filename);
    })
  );
});

const requireWorkspace = Effect.fn("Workspace.require")(
  function* requireWorkspace(root: string) {
    const fs = yield* FileSystem.FileSystem;
    const filename = workspacePaths(root).marker;
    if (!(yield* fs.exists(filename))) {
      return yield* new WorkspaceError({
        message: "Run 'effectory init' in this workspace first.",
      });
    }
    return yield* Schema.decodeEffect(Schema.fromJsonString(WorkspaceConfig))(
      yield* fs.readFileString(filename)
    );
  }
);

export const initializeWorkspace = Effect.fn("Workspace.initialize")(
  function* initializeWorkspace(root: string) {
    const path = yield* Path.Path;
    const filename = workspacePaths(root).marker;
    yield* writeNewJson(filename, { project: ".effectory", version: 1 }).pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error)
      )
    );
    const config = yield* requireWorkspace(root);
    if (config.project === ".effectory") {
      const defaults = {
        "package.json": {
          dependencies: {
            "@effectory/activities": "0.1.2",
            "@effectory/cli": "0.1.2",
            "@effectory/sdk": "0.1.2",
            effect: "4.0.5",
          },
          name: "effectory-workspace",
          private: true,
          scripts: { effectory: "effectory" },
          type: "module",
        },
        "tsconfig.json": {
          compilerOptions: {
            allowImportingTsExtensions: true,
            module: "ESNext",
            moduleResolution: "Bundler",
            noEmit: true,
            skipLibCheck: true,
            strict: true,
            target: "ES2024",
          },
          include: ["automations/**/*.ts"],
        },
      };
      for (const [name, value] of Object.entries(defaults)) {
        yield* writeNewJson(path.join(root, ".effectory", name), value).pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "AlreadyExists"
              ? Effect.void
              : Effect.fail(error)
          )
        );
      }
    }
    return { version: 1, workspace: path.resolve(root) };
  }
);

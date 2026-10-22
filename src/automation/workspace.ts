import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { checkHttp, HttpCheckConfig, HttpCheckResult } from "./http-check.ts";

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  message: string;
}> {}

export const CheckName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/u)
);

export const WorkspaceConfig = Schema.Struct({ version: Schema.Literal(1) });

export const CheckDefinition = Schema.Struct({
  config: HttpCheckConfig,
  name: CheckName,
  type: Schema.Literal("http/check"),
  version: Schema.Literal(1),
});

export const CheckRecord = Schema.Struct({
  definition: CheckDefinition,
  id: Schema.String,
  result: HttpCheckResult,
  schemaVersion: Schema.Literal(1),
  startedAt: Schema.Finite,
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
    const path = yield* Path.Path;
    const filename = path.join(root, "automation", "workspace.json");
    if (!(yield* fs.exists(filename))) {
      return yield* new WorkspaceError({
        message: "Run 'automation init' in this workspace first.",
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
    const filename = path.join(root, "automation", "workspace.json");
    yield* writeNewJson(filename, { version: 1 }).pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error)
      )
    );
    yield* requireWorkspace(root);
    return { version: 1, workspace: path.resolve(root) };
  }
);

export const createCheck = Effect.fn("Workspace.createCheck")(
  function* createCheck(root: string, input: unknown) {
    yield* requireWorkspace(root);
    const definition =
      yield* Schema.decodeUnknownEffect(CheckDefinition)(input);
    const path = yield* Path.Path;
    yield* writeNewJson(
      path.join(root, "automation", "checks", `${definition.name}.json`),
      definition
    ).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(
          error.reason._tag === "AlreadyExists"
            ? new WorkspaceError({
                message: `Check '${definition.name}' already exists.`,
              })
            : error
        )
      )
    );
    return definition;
  }
);

export const runCheck = Effect.fn("Workspace.runCheck")(function* runCheck(
  root: string,
  inputName: string
) {
  yield* requireWorkspace(root);
  const name = yield* Schema.decodeEffect(CheckName)(inputName);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const definition = yield* Schema.decodeEffect(
    Schema.fromJsonString(CheckDefinition)
  )(
    yield* fs.readFileString(
      path.join(root, "automation", "checks", `${name}.json`)
    )
  );
  if (definition.name !== name) {
    return yield* new WorkspaceError({
      message: "Check name does not match its filename.",
    });
  }
  const startedAt = yield* Clock.currentTimeMillis;
  const result = yield* checkHttp(definition.config);
  const record = yield* Schema.decodeEffect(CheckRecord)({
    definition,
    id: yield* crypto.randomUUIDv4(),
    result,
    schemaVersion: 1,
    startedAt,
  });
  yield* writeNewJson(
    path.join(root, ".automation", "results", name, `${record.id}.json`),
    record
  );
  return record;
});

export const listResults = Effect.fn("Workspace.listResults")(
  function* listResults(root: string, inputName: string) {
    yield* requireWorkspace(root);
    const name = yield* Schema.decodeEffect(CheckName)(inputName);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(root, ".automation", "results", name);
    const files = yield* fs
      .readDirectory(directory)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed([] as string[])
            : Effect.fail(error)
        )
      );
    // Effect traversal, not Array.forEach.
    // oxlint-disable-next-line unicorn/no-array-for-each
    const records = yield* Effect.forEach(
      files.filter((file) => file.endsWith(".json")),
      (file) =>
        fs
          .readFileString(path.join(directory, file))
          .pipe(
            Effect.flatMap(
              Schema.decodeEffect(Schema.fromJsonString(CheckRecord))
            )
          )
    );
    return records.toSorted(
      (left, right) =>
        left.startedAt - right.startedAt || left.id.localeCompare(right.id)
    );
  }
);

/** Finding and loading `flow.run.ts`, and the store runs are kept in. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Flow } from "@effectory/flow";
import { Data, Effect, Layer } from "effect";

/** The default entry file, in the current directory. */
export const entryFile = "flow.run.ts";
/** The default store, next to the entry file. */
export const storeFile = path.join(".effectory", "runs.db");

export class LoadError extends Data.TaggedError("LoadError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Import `file` and check that it default-exports `Flow.make(...)`. */
export const loadApp = (file: string) =>
  Effect.gen(function* load() {
    const module = yield* Effect.tryPromise({
      catch: (cause) =>
        new LoadError({
          cause,
          message: `Could not load ${file}: ${String(cause)}`,
        }),
      try: () =>
        import(pathToFileURL(file).href) as Promise<{
          readonly default?: unknown;
        }>,
    });
    if (!Flow.isApp(module.default)) {
      return yield* new LoadError({
        message: `${file} must default-export Flow.make(...)`,
      });
    }
    return module.default;
  });

/** A SQLite store at `file`, creating its directory if needed. */
export const sqliteStore = (file: string) =>
  Flow.sqlStore.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.sync(() => {
          mkdirSync(path.dirname(file), { recursive: true });
          return SqliteClient.layer({ filename: file });
        })
      )
    )
  );

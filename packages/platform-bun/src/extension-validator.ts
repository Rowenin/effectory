import { rmSync } from "node:fs";
import path from "node:path";

import type { ExtensionLock } from "@effectory/runtime/extension-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import { runBounded } from "./bounded-process.ts";
import { assertTrusted, replaceFile } from "./extension-bindings.ts";
import { compiled, internalCommand, selfCommand } from "./host-runtime.ts";
import { RepositoryLease } from "./ownership.ts";

const failure = () =>
  new OperationError({
    code: "InvalidInput",
    message:
      "Extension exports could not be loaded, disagree with their manifests, or exceeded the 30-second validation limit",
  });
/** A compiled binary re-enters itself; a source run starts the worker file. */
export const validationCommand = (repository: string, input: string) =>
  selfCommand(path.join(import.meta.dir, "extension-validate-worker.ts"), [
    ...(compiled ? [internalCommand, "validate-extensions"] : []),
    repository,
    input,
  ]);
export function validateExtensions(
  repository: string,
  lock: typeof ExtensionLock.Type
) {
  return Effect.gen(function* () {
    const lease = yield* RepositoryLease;
    const filename = path.join(
      repository,
      ".effectory",
      "extensions",
      `validate-${crypto.randomUUID()}.json`
    );
    return yield* Effect.acquireUseRelease(
      Effect.try({
        catch: failure,
        try: () => {
          lease.assertActive();
          assertTrusted(repository, lock);
          replaceFile(filename, JSON.stringify(lock));
          return filename;
        },
      }),
      (input) =>
        Effect.gen(function* () {
          const bytes = yield* runBounded(
            validationCommand(repository, input),
            { failure, maximumBytes: 4096 }
          );
          const report = yield* Effect.try({
            catch: failure,
            try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
          });
          yield* Schema.decodeUnknownEffect(
            Schema.Struct({ valid: Schema.Literal(true) })
          )(report, { onExcessProperty: "error" }).pipe(
            Effect.mapError(failure)
          );
        }),
      (input) => Effect.sync(() => rmSync(input, { force: true }))
    );
  });
}

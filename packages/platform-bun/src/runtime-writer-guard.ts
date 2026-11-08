import { OperationError } from "@effectory/runtime/protocol";

import { hostAbi } from "./host-runtime.ts";
import { readRuntimeStorage } from "./runtime-storage-format.ts";

/** Normal offline writers never inherit permission from merely understanding a storage schema. */
export function assertRuntimeWriter(repository: string) {
  // This also refuses active/unknown upgrade intents before any database opens.
  const storage = readRuntimeStorage(repository);
  if (
    storage !== null &&
    (storage.targetBuild !== hostAbi() ||
      storage.platform !== process.platform ||
      storage.architecture !== process.arch)
  ) {
    throw new OperationError({
      code: "RevisionUnavailable",
      message: `Runtime storage belongs to host build ${storage.targetBuild}; use that host or complete a certified offline upgrade before maintenance`,
    });
  }
}

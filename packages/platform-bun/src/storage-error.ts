import { TaskRuntimeError } from "@effectory/core";
import { OperationError } from "@effectory/runtime/protocol";

export function storageError(cause: unknown, message: string) {
  if (cause instanceof TaskRuntimeError && cause.code === "LimitExceeded") {
    return new OperationError({
      code: "LimitExceeded",
      message: cause.message,
    });
  }
  if (cause instanceof OperationError) {
    return cause;
  }
  const code =
    typeof cause === "object" && cause !== null
      ? Reflect.get(cause, "code")
      : null;
  return new OperationError(
    code === "SQLITE_FULL" || code === "ENOSPC" || code === "EDQUOT"
      ? {
          code: "StorageFull",
          message:
            "Repository storage is full; free space before retrying the original request",
        }
      : { code: "Unavailable", message }
  );
}

import { OperationError } from "@effectory/runtime/protocol";
import { TaskRuntimeError } from "@offtree/effectory-sdk";

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
  // PlatformError wraps native errno in reason/cause; traverse a bounded graph.
  const pending: unknown[] = [cause];
  const seen = new Set<unknown>();
  let full = false;
  for (let visited = 0; pending.length > 0 && visited < 32; visited += 1) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const code: unknown = Reflect.get(current, "code");
    if (code === "SQLITE_FULL" || code === "ENOSPC" || code === "EDQUOT") {
      full = true;
      break;
    }
    pending.push(Reflect.get(current, "cause"), Reflect.get(current, "reason"));
  }
  return new OperationError(
    full
      ? {
          code: "StorageFull",
          message:
            "Repository storage is full; free space before retrying the original request",
        }
      : { code: "Unavailable", message }
  );
}

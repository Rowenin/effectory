import { OperationError } from "@effectory/runtime/protocol";
import { RunTags } from "@offtree/effectory-sdk/RunTags";
import { Effect, Schema } from "effect";

/** Flag parsers throw OperationError; anything else is reported as invalid input. */
export const inputError = (cause: unknown) =>
  cause instanceof OperationError
    ? cause
    : new OperationError({ code: "InvalidInput", message: String(cause) });

export function parseTags(
  values: readonly string[],
  flag = "--tag"
): typeof RunTags.Type {
  const entries: [string, string][] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator === -1) {
      throw new OperationError({
        code: "InvalidInput",
        message: `Use ${flag} KEY=VALUE`,
      });
    }
    const key = value.slice(0, separator);
    if (seen.has(key)) {
      throw new OperationError({
        code: "InvalidInput",
        message: `Duplicate ${flag} key: ${key}`,
      });
    }
    seen.add(key);
    entries.push([key, value.slice(separator + 1)]);
  }
  try {
    return Schema.decodeSync(RunTags)(Object.fromEntries(entries));
  } catch (error) {
    throw new OperationError({
      code: "InvalidInput",
      message: `Invalid ${flag}: ${String(error).slice(0, 1700)}`,
    });
  }
}

export function tagsFor<E, R>(
  client: {
    readonly SystemStatus: (
      request: Record<string, never>
    ) => Effect.Effect<{ readonly capabilities: readonly string[] }, E, R>;
  },
  values: readonly string[]
) {
  return Effect.gen(function* () {
    const tags = yield* Effect.try({
      catch: inputError,
      try: () => parseTags(values),
    });
    const payload: { readonly tags?: Readonly<Record<string, string>> } = {};
    if (Object.keys(tags).length === 0) {
      return payload;
    }
    const status = yield* client.SystemStatus({});
    if (!status.capabilities.includes("run-tags.v1")) {
      return yield* new OperationError({
        code: "Unavailable",
        message:
          "This daemon does not support run tags; upgrade and restart the daemon before using --tag",
      });
    }
    return { tags };
  });
}

import { DefinitionError } from "@offtree/effectory-sdk";
import { Duration, Option, Schema } from "effect";

export interface SecretReference {
  readonly secretId: string;
  readonly versionId?: string;
  readonly versionStage?: string;
}

export interface Options {
  readonly region: string;
  readonly secrets: Readonly<Record<string, string | SecretReference>>;
  readonly requestTimeout?: Duration.Input;
}

const key = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u)
);
const reference = Schema.Struct({
  secretId: Schema.NonEmptyString,
  versionId: Schema.optionalKey(Schema.NonEmptyString),
  versionStage: Schema.optionalKey(Schema.NonEmptyString),
});
const options = Schema.Struct({
  region: Schema.NonEmptyString,
  requestTimeout: Schema.optionalKey(Schema.Unknown),
  secrets: Schema.Record(
    Schema.String,
    Schema.Union([Schema.NonEmptyString, reference])
  ).check(Schema.isPropertyNames(key), Schema.isMaxProperties(256)),
});

export interface CapturedOptions {
  readonly region: string;
  readonly secrets: Readonly<Record<string, SecretReference>>;
  readonly timeoutMillis: number;
}

export function capture(input: Options): CapturedOptions {
  try {
    const decoded = Schema.decodeUnknownSync(options)(input, {
      onExcessProperty: "error",
    });
    if (
      Object.hasOwn(decoded, "requestTimeout") &&
      decoded.requestTimeout === undefined
    ) {
      throw new Error("Undefined timeout");
    }
    const duration = Duration.fromInput(
      (Object.hasOwn(decoded, "requestTimeout")
        ? decoded.requestTimeout
        : "30 seconds") as Duration.Input
    );
    const timeoutMillis = Option.isSome(duration)
      ? Duration.toMillis(duration.value)
      : Number.NaN;
    if (
      !Number.isFinite(timeoutMillis) ||
      timeoutMillis <= 0 ||
      timeoutMillis > 300_000
    ) {
      throw new Error("Invalid timeout");
    }
    return Object.freeze({
      region: decoded.region,
      secrets: Object.freeze(
        Object.fromEntries(
          Object.entries(decoded.secrets).map(([name, value]) => [
            name,
            Object.freeze(
              typeof value === "string" ? { secretId: value } : { ...value }
            ),
          ])
        )
      ),
      timeoutMillis,
    });
  } catch {
    // Do not echo submitted options: locators or mistaken credential values
    // may be present in the schema error or a throwing accessor.
    throw new DefinitionError({
      message:
        "Invalid AWS vault options: provide a region, declared-key secret mappings, and a positive requestTimeout of at most five minutes",
    });
  }
}

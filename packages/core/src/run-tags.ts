import { Schema } from "effect";

const Key = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/u)
);
const Value = Schema.String.check(Schema.isMaxLength(256));

/** Encoded run metadata. Domain-specific codecs are validated by the root workflow. */
export const RunTags = Schema.Record(Schema.String, Value).check(
  Schema.isPropertyNames(Key),
  Schema.isMaxProperties(32),
  Schema.makeFilter(
    (tags) => new TextEncoder().encode(JSON.stringify(tags)).byteLength <= 4096,
    { expected: "run tags encoded as JSON within 4096 UTF-8 bytes" }
  )
);

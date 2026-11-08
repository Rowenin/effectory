import { Schema } from "effect";

import { RunTags } from "./run-tags.ts";

const Id = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u)
);
const Ids = Schema.Array(Id).check(Schema.isMaxLength(128));
export const EncodedSelection = Schema.Struct({
  only: Schema.optionalKey(Ids),
  onlyTags: Schema.optionalKey(RunTags),
  skip: Schema.optionalKey(Ids),
  skipAll: Schema.optionalKey(Schema.Boolean),
  skipTags: Schema.optionalKey(RunTags),
});
export const SelectionDecision = Schema.Struct({
  excluded: Ids,
  requested: EncodedSelection,
  required: Ids,
  selected: Ids,
}).check(
  Schema.makeFilter(
    (value) => {
      const selected = new Set(value.selected);
      const excluded = new Set(value.excluded);
      const required = new Set(value.required);
      return (
        selected.size === value.selected.length &&
        excluded.size === value.excluded.length &&
        required.size === value.required.length &&
        selected.size + excluded.size <= 128 &&
        [...excluded].every((id) => !selected.has(id)) &&
        [...required].every((id) => selected.has(id)) &&
        new TextEncoder().encode(JSON.stringify(value)).byteLength <= 131_072
      );
    },
    { expected: "a disjoint, bounded report selection decision" }
  )
);

/** Encoded data only: safe before receipt lookup and inside admission. */
export function normalizeSelection(
  value: unknown
): typeof EncodedSelection.Type {
  const input = Schema.decodeUnknownSync(EncodedSelection)(value, {
    onExcessProperty: "error",
  });
  const only = [...new Set(input.only)].toSorted();
  const skip = [...new Set(input.skip)].toSorted();
  const onlyTags = input.onlyTags ?? {};
  const skipTags = input.skipTags ?? {};
  if (
    input.skipAll &&
    (only.length ||
      skip.length ||
      Object.keys(onlyTags).length ||
      Object.keys(skipTags).length)
  ) {
    throw new Error("skipAll cannot be combined with other report selectors");
  }
  return Object.freeze({
    ...(only.length ? { only: Object.freeze(only) } : {}),
    ...(Object.keys(onlyTags).length
      ? { onlyTags: Object.freeze(onlyTags) }
      : {}),
    ...(skip.length ? { skip: Object.freeze(skip) } : {}),
    ...(input.skipAll ? { skipAll: true } : {}),
    ...(Object.keys(skipTags).length
      ? { skipTags: Object.freeze(skipTags) }
      : {}),
  });
}

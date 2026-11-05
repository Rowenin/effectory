import { expect, test } from "bun:test";

import { Artifact } from "@effectory/core";
import { Schema } from "effect";

test("queryable fields use encoded types through references, optional values and array paths", () => {
  const Child = Schema.Struct({ value: Schema.NumberFromString }).annotate({
    identifier: "Child",
  });
  const artifact = Artifact.make({
    fields: [["child", "value"], ["optional"], ["entries", "0", "enabled"]],
    id: "query/typed",
    schema: Schema.Struct({
      child: Child,
      entries: Schema.Array(Schema.Struct({ enabled: Schema.Boolean })),
      optional: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
    }),
    version: 1,
  });
  expect(artifact.queryFields).toEqual([
    { path: ["child", "value"], types: ["string"] },
    { path: ["optional"], types: ["null", "number"] },
    { path: ["entries", "0", "enabled"], types: ["boolean"] },
  ]);
  expect(() =>
    Artifact.make({
      fields: [["unknown"]],
      id: "query/missing",
      schema: Schema.Struct({ known: Schema.String }),
      version: 1,
    })
  ).toThrow("absent");
});

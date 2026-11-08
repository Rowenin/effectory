import { expect, test } from "bun:test";

import { Schema } from "effect";

import { RunTags } from "../src/run-tags.ts";

const decode = Schema.decodeUnknownSync(RunTags);

test("wire tags preserve exact string values and reject malformed keys by default", () => {
  expect(decode({ build: "042", label: "", "team/name": "platform" })).toEqual({
    build: "042",
    label: "",
    "team/name": "platform",
  });
  for (const value of [
    { "bad:key": "x" },
    { "-bad": "x" },
    { "": "x" },
    JSON.parse('{"__proto__":"x"}'),
    { build: 42 },
    null,
    undefined,
    [],
  ]) {
    expect(() => decode(value)).toThrow();
  }
});

test("run metadata has independent key, value, count and UTF-8 byte limits", () => {
  expect(() => decode({ ["a".repeat(64)]: "x".repeat(256) })).not.toThrow();
  expect(() => decode({ ["a".repeat(65)]: "x" })).toThrow();
  expect(() => decode({ label: "x".repeat(257) })).toThrow();
  expect(() => decode({ label: "😀".repeat(129) })).toThrow();
  expect(() =>
    decode(
      Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, "x"]))
    )
  ).not.toThrow();
  expect(() =>
    decode(
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, "x"]))
    )
  ).toThrow();
  expect(() =>
    decode(
      Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`k${i}`, "😀".repeat(128)])
      )
    )
  ).toThrow("4096");
});

test("JSON Schema advertises property names, count and value length", () => {
  const document = Schema.toJsonSchemaDocument(RunTags);
  expect(document.schema).toMatchObject({
    additionalProperties: { maxLength: 256, type: "string" },
    maxProperties: 32,
    propertyNames: { pattern: "^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$" },
    type: "object",
  });
});

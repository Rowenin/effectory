import { expect, test } from "bun:test";

import { workflowDescription, workflowList } from "../src/format.ts";

test("lists workflows in aligned columns", () => {
  expect(
    workflowList([
      { description: "Check monitors.", name: "health-check" },
      { description: "Review a branch.", name: "review-branch" },
    ])
  ).toBe(
    [
      "NAME           DESCRIPTION",
      "health-check   Check monitors.",
      "review-branch  Review a branch.",
    ].join("\n")
  );
  expect(workflowList([])).toBe(
    "No workflows registered. List them in effectory.run.ts."
  );
});

test("describes nested, optional, and constrained input fields", () => {
  const text = workflowDescription({
    description: "Check monitors.",
    inputSchema: {
      definitions: {
        Level: { enum: ["low", "high"], type: "string" },
      },
      schema: {
        properties: {
          concurrency: {
            anyOf: [
              { maximum: 3, minimum: 1, type: "integer" },
              { type: "null" },
            ],
          },
          level: { $ref: "#/$defs/Level" },
          monitors: {
            items: {
              properties: {
                config: {
                  properties: {
                    timeoutMs: {
                      description: "Time limit in milliseconds (1–60000)",
                      maximum: 60_000,
                      minimum: 1,
                      type: "integer",
                    },
                  },
                  required: ["timeoutMs"],
                  type: "object",
                },
                name: { pattern: "^[a-z]+$", type: "string" },
              },
              required: ["config", "name"],
              type: "object",
            },
            maxItems: 20,
            minItems: 1,
            type: "array",
          },
          requestId: { maxLength: 128, minLength: 1, type: "string" },
        },
        required: ["level", "monitors", "requestId"],
        type: "object",
      },
    },
    name: "health-check",
    revision: "5d4fdb7d39abcdef",
  });
  expect(text).toBe(
    [
      "health-check",
      "Check monitors.",
      "",
      "Input",
      "  concurrency    integer | null   optional  1–3",
      '  level          "low" | "high"   required',
      "  monitors       array of object  required  1–20 items",
      "    config       object           required",
      "      timeoutMs  integer          required  Time limit in milliseconds (1–60000)",
      "    name         string           required  matches ^[a-z]+$",
      "  requestId      string           required  1–128 chars",
      "",
      "Revision  5d4fdb7d39ab",
      "Run       effectory workflow run health-check --input <file.json>",
    ].join("\n")
  );
});

test("describes a workflow without input fields", () => {
  expect(
    workflowDescription({
      description: "No input.",
      inputSchema: { schema: { type: "object" } },
      name: "empty",
      revision: "abc",
    })
  ).toContain("Input\n  (none)");
});

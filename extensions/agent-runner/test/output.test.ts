/* oxlint-disable no-await-in-loop -- Sequential attempts share a publication counter and runtime identity. */
import { expect, test } from "bun:test";

import { Task } from "@offtree/effectory-sdk";
import { Effect, Layer, Schema } from "effect";

import { AgentRunner, makeTask } from "../src/contracts.ts";

function runner(
  output: string,
  capture?: (schema: Schema.Json | undefined) => void
) {
  return Layer.succeed(AgentRunner, {
    run: (_input, _progress, schema) => {
      capture?.(schema);
      return Effect.succeed({
        result: {
          output,
          platform: "fixture",
          version: "fixture",
          workingDirectory: "/tmp",
        },
        transcript: [],
      });
    },
  });
}
const input = {
  platform: "fixture",
  policy: "read",
  prompt: "test",
  workingDirectory: "/tmp",
};

test("plain Schema.String keeps text output and passes no provider schema", async () => {
  const task = makeTask({ id: "test/text", output: Schema.String, version: 1 });
  let schema: Schema.Json | undefined;
  const result = await Effect.runPromise(
    Task.test(task, { input }).pipe(
      Effect.provide(
        runner("plain response", (value) => {
          schema = value;
        })
      )
    )
  );
  const text: string = result.value.output;
  expect(text).toBe("plain response");
  expect(schema).toBeUndefined();
});
test("canonical JSON codecs preserve transformations through publication and persistence", async () => {
  const task = makeTask({
    id: "test/transform",
    output: Schema.FiniteFromString,
    version: 1,
  });
  const result = await Effect.runPromise(
    Task.test(task, { input }).pipe(Effect.provide(runner('{"output":"42"}')))
  );
  const value: number = result.value.output;
  expect(value).toBe(42);
  expect(result.publications[0]?.value).toMatchObject({ output: "42" });
  const encoded = Schema.encodeSync(task.successSchema)(result.value);
  expect(Schema.decodeSync(task.successSchema)(encoded).output).toBe(42);
});
test("schema checks and excess fields are enforced locally without publishing invalid output", async () => {
  const task = makeTask({
    id: "test/check",
    output: Schema.Struct({
      value: Schema.String.check(Schema.isMinLength(3)),
    }),
    version: 1,
  });
  let publications = 0;
  const runtime: Task.RuntimeContext = {
    attempt: 1,
    attemptId: "test",
    invocationPath: "test",
    key: (name) => name,
    progress: () => Effect.void,
    publish: () => {
      publications += 1;
      return Effect.die("Invalid output must not be published");
    },
    revision: "test",
    runId: "test",
    taskId: task.id,
    taskVersion: 1,
  };
  for (const output of [
    '{"output":{"value":"x"}}',
    '{"output":{"value":"valid","extra":true}}',
    '{"output":{"value":"valid"},"extra":true}',
    '```json\n{"output":{"value":"valid"}}\n```',
  ]) {
    const error = await Effect.runPromise(
      task
        .execute(input, runtime)
        .pipe(Effect.provide(runner(output)), Effect.flip)
    );
    expect(error).toMatchObject({ code: "InvalidStructuredOutput" });
    expect(error.message).toBe(
      "Agent response does not match the declared output schema"
    );
  }
  expect(publications).toBe(0);
});
test("text override validates refined strings and rejects non-string schemas before execution", async () => {
  const task = makeTask({
    format: "text",
    id: "test/refined-text",
    output: Schema.String.check(Schema.isMinLength(3)),
    version: 1,
  });
  const result = await Effect.runPromise(
    Task.test(task, { input }).pipe(Effect.provide(runner("valid")))
  );
  expect(result.value.output).toBe("valid");
  expect(() =>
    makeTask({
      format: "text",
      id: "test/bad-text",
      output: Schema.Int,
      version: 1,
    })
  ).toThrow("string-encoded");
});

test("named recursive schemas keep their definitions and decode recursively", async () => {
  interface Tree {
    readonly name: string;
    readonly children: readonly Tree[];
  }
  const tree: Schema.Codec<Tree, Tree> = Schema.Struct({
    children: Schema.Array(Schema.suspend(() => tree)),
    name: Schema.String,
  }).annotate({ identifier: "Tree" });
  const task = makeTask({ id: "test/tree", output: tree, version: 1 });
  let definition: Schema.Json | undefined;
  const expected = { children: [{ children: [], name: "leaf" }], name: "root" };
  const result = await Effect.runPromise(
    Task.test(task, { input }).pipe(
      Effect.provide(
        runner(JSON.stringify({ output: expected }), (schema) => {
          definition = schema;
        })
      )
    )
  );
  expect(result.value.output).toEqual(expected);
  expect(JSON.stringify(definition)).toContain('"$defs"');
  expect(JSON.stringify(definition)).toContain("#/$defs/Tree");
});

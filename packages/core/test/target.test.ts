import { describe, expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";

import * as Engine from "../src/engine.ts";
import * as State from "../src/state.ts";
import * as Target from "../src/target.ts";
import * as Workflow from "../src/workflow.ts";

const Repo = Schema.Struct({
  commands: Schema.Array(Schema.String),
  name: Schema.String,
  owner: Schema.String,
});

const verify = Workflow.make(
  "verify",
  {
    description: "",
    input: Schema.Struct({ pr: Schema.Finite, repo: Repo }),
    scope: ({ pr, repo }) => `${repo.owner}/${repo.name}#${pr}`,
  },
  (input) => Effect.succeed(input)
);

const app = Target.make(
  verify,
  "cypress-app",
  { repo: { commands: ["test"], name: "app", owner: "cypress-io" } },
  { description: "The app repo" }
);

describe("Target", () => {
  test("make keeps the preset and derives a version", () => {
    expect(app).toMatchObject({
      _tag: "Target",
      description: "The app repo",
      input: { repo: { commands: ["test"], name: "app", owner: "cypress-io" } },
      name: "cypress-app",
      workflow: verify,
    });
    expect(app.version).toMatch(/^[\da-f]{12}$/u);
    expect(Target.make(verify, "v", {}, { version: "2" }).version).toBe("2");
    expect(Target.isTarget(app)).toBe(true);
    expect(() => Target.make(verify, "a/b", {})).toThrow("Invalid target name");
  });

  test("resolve deep-merges overrides, including dotted keys", () => {
    expect(
      Target.resolve(app, {
        pr: 12,
        "repo.commands": ["lint"],
        "repo.name": "docs",
      })
    ).toEqual({
      pr: 12,
      repo: { commands: ["lint"], name: "docs", owner: "cypress-io" },
    });
    expect(Target.resolve(app)).toEqual(app.input);
    expect(app.input).toEqual({
      repo: { commands: ["test"], name: "app", owner: "cypress-io" },
    });
  });

  test("parseAssignments parses JSON values and nests dotted keys", () => {
    expect(
      Target.parseAssignments([
        "pr=12",
        "repo.name=app",
        'flags=["a"]',
        "note=hello world",
        "eq=a=b",
        "on=true",
      ])
    ).toEqual({
      eq: "a=b",
      flags: ["a"],
      note: "hello world",
      on: true,
      pr: 12,
      repo: { name: "app" },
    });
    expect(() => Target.parseAssignments(["nope"])).toThrow("key=value");
  });

  test("a resolved target is valid workflow input", async () => {
    const input = Target.resolve(
      app,
      Target.parseAssignments(["pr=7", "repo.owner=acme"])
    );
    const summary = await Effect.runPromise(
      Effect.flatMap(Engine.Engine, (engine) =>
        engine.run(verify, input, {
          collection: "test",
          revision: "r1",
          target: app.name,
        })
      ).pipe(
        Effect.provide(Engine.layer.pipe(Layer.provideMerge(State.memory)))
      )
    );
    expect(summary.run.scope).toBe("acme/app#7");
    expect(summary.run.target).toBe("cypress-app");
  });
});

import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import * as Action from "../src/action.ts";
import * as Collection from "../src/collection.ts";
import { describe as describeCollection, jsonSchema } from "../src/describe.ts";
import * as Provider from "../src/provider.ts";
import * as Resource from "../src/resource.ts";
import * as Target from "../src/target.ts";
import * as Trigger from "../src/trigger.ts";
import * as Workflow from "../src/workflow.ts";

const Echo = Action.make("Echo", {
  description: "Echo a message",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ echoed: Schema.String }),
  rerun: "on-change",
  run: ({ message }) => Effect.succeed({ echoed: message }),
});

const Note = Resource.make("Test.Note", {
  attributes: Schema.Struct({ id: Schema.Int }),
  description: "A note",
  props: Schema.Struct({ body: Schema.String }),
});

const greet = Workflow.make(
  "greet",
  {
    description: "Greet someone",
    input: Schema.Struct({
      name: Schema.String,
      times: Schema.optionalKey(Schema.Int),
    }),
  },
  Effect.fn(function* greetBody({ name }) {
    const echoed = yield* Echo("say", { message: name });
    yield* Note("note", { body: echoed.echoed });
  })
);

const ping = Workflow.make(
  "ping",
  { description: "", input: Schema.Struct({ name: Schema.String }) },
  ({ name }) => Effect.succeed(name)
);

const preset = Target.make(ping, "world", { name: "world" });

// Collection.make rejects concrete Actions and Resources (Output<any> in
// Action.Any/Resource.Any resolves to the array branch of Output's Props), so
// they are added after make.
const collection = Collection.make({
  actions: [Echo],
  description: "Fixtures",
  name: "fixtures",
  providers: Provider.succeed(
    Note,
    Provider.memory(Note, { attributes: () => ({ id: 1 }) })
  ),
  resources: [Note],
  targets: [preset],
  triggers: [
    Trigger.schedule("0 3 * * *", preset),
    Trigger.webhook({
      map: () => ({ name: "hook" }),
      route: "/greet",
      workflow: greet,
    }),
  ],
  workflows: [greet, ping],
});

describe("describe", () => {
  test("jsonSchema emits a standalone draft 2020-12 schema", () => {
    expect(jsonSchema(Schema.Struct({ ok: Schema.Boolean }))).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: true,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      type: "object",
    });
  });

  test("lists workflows, Actions, Resources, Targets, and Triggers", () => {
    const described = describeCollection(collection);
    expect(described.name).toBe("fixtures");
    expect(described.description).toBe("Fixtures");
    expect(described.workflows).toHaveLength(2);
    expect(described.workflows[0]).toMatchObject({
      description: "Greet someone",
      input: { required: ["name"], type: "object" },
      name: "greet",
    });
    expect(described.actions[0]).toMatchObject({
      description: "Echo a message",
      output: { properties: { echoed: { type: "string" } } },
      rerun: "on-change",
      retry: "auto",
      type: "Echo",
    });
    expect(described.resources[0]).toMatchObject({
      attributes: { properties: { id: { type: "integer" } } },
      description: "A note",
      props: { properties: { body: { type: "string" } } },
      type: "Test.Note",
    });
    expect(described.targets).toEqual([
      {
        description: "",
        input: { name: "world" },
        name: "world",
        version: preset.version,
        workflow: "ping",
      },
    ]);
    expect(described.triggers).toEqual([
      {
        cron: "0 3 * * *",
        kind: "schedule",
        name: "world@0 3 * * *",
        target: "world",
        workflow: "ping",
      },
      {
        kind: "webhook",
        name: "/greet",
        route: "/greet",
        verified: false,
        workflow: "greet",
      },
    ]);
  });
});

/** A small collection exercising every CLI command. */
import {
  Action,
  Approve,
  Assert,
  Collection,
  Output,
  Provider,
  Resource,
  Target,
  Trigger,
  Workflow,
} from "@effectory/core";
import { Effect, Schema } from "effect";

import { suffix } from "./greeting.ts";

export const Greet = Action.make("Greet", {
  description: "Compose a greeting",
  input: Schema.Struct({ greeting: Schema.String, name: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  run: ({ greeting, name }) =>
    Effect.succeed({ message: `${greeting}, ${name}${suffix}` }),
});

export const Note = Resource.make("Fixture.Note", {
  attributes: Schema.Struct({ body: Schema.String, id: Schema.String }),
  description: "A note kept per scope",
  props: Schema.Struct({ body: Schema.String }),
});

const NoteProvider = Provider.succeed(
  Note,
  Provider.memory(Note, {
    attributes: (props, fqn) => ({ body: props.body, id: fqn }),
  })
);

export const hello = Workflow.make(
  "hello",
  {
    description: "Greet someone and keep a note",
    input: Schema.Struct({
      greeting: Schema.optionalKey(Schema.String),
      name: Schema.String,
    }),
    scope: ({ name }) => name,
  },
  Effect.fn(function* helloBody({ greeting, name }) {
    const greeted = yield* Greet("greet", {
      greeting: greeting ?? "Hello",
      name,
    });
    const note = yield* Note("note", { body: greeted.message });
    yield* Assert("greeted", {
      message: "the greeting is not empty",
      severity: "low",
      that: Output.map(greeted, (result) => result.message.length > 0),
    });
    return { message: greeted.message, note: note.id };
  })
);

export const check = Workflow.make(
  "check",
  {
    description: "Assert that the greeting matches",
    input: Schema.Struct({ expected: Schema.String, name: Schema.String }),
    scope: ({ expected, name }) => `${name}:${expected}`,
  },
  Effect.fn(function* checkBody({ expected, name }) {
    const greeted = yield* Greet("greet", { greeting: "Hello", name });
    yield* Assert("matches", {
      message: Output.map(
        greeted,
        (result) => `expected "${expected}", got "${result.message}"`
      ),
      severity: "medium",
      that: Output.map(greeted, (result) => result.message === expected),
    });
  })
);

export const gated = Workflow.make(
  "gated",
  {
    description: "Greet, wait for approval, then greet again",
    input: Schema.Struct({ name: Schema.String }),
    scope: ({ name }) => `gated:${name}`,
  },
  Effect.fn(function* gatedBody({ name }) {
    const before = yield* Greet("before", { greeting: "Hello", name });
    const decision = yield* Approve("ship", {
      review: { message: before.message },
      title: Output.map(before, (result) => `Ship "${result.message}"?`),
    });
    const after = yield* Greet(
      "after",
      { greeting: "Shipped", name },
      { dependsOn: [decision] }
    );
    return { message: after.message };
  })
);

export const team = Target.make(
  hello,
  "team",
  { greeting: "Hi", name: "team" },
  { description: "Greet the team" }
);

const collection = Collection.make({
  actions: [Greet],
  description: "CLI test fixture",
  name: "cli-fixture",
  providers: NoteProvider,
  resources: [Note],
  targets: [team],
  triggers: [
    Trigger.webhook({
      map: (event) => ({ name: (event as { readonly name: string }).name }),
      route: "/hello",
      workflow: hello,
    }),
  ],
  workflows: [hello, check, gated],
});

export default collection;

import { afterEach, describe, expect, test } from "bun:test";

import { Effect, Layer, Redacted, Schema } from "effect";

import * as Action from "../src/action.ts";
import * as Engine from "../src/engine.ts";
import * as Output from "../src/output.ts";
import { Secret, SecretStore, envName } from "../src/secret.ts";
import * as State from "../src/state.ts";
import * as Workflow from "../src/workflow.ts";

const options = { collection: "test", revision: "r1" };
const value = "s3cr3t-value-do-not-leak";

const runWith = <A, E>(
  store: Layer.Layer<SecretStore>,
  effect: Effect.Effect<A, E, Engine.Engine | State.State | SecretStore>
) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      Layer.mergeAll(Engine.layer.pipe(Layer.provideMerge(State.memory)), store)
    )
  );

const seen: string[] = [];

const Call = Action.make("Call", {
  input: Schema.Struct({
    token: Schema.Redacted(Schema.String),
    url: Schema.String,
  }),
  output: Schema.Struct({ authorized: Schema.Boolean }),
  run: ({ token }) =>
    Effect.sync(() => {
      seen.push(Redacted.value(token));
      return { authorized: Redacted.value(token) === value };
    }),
});

const workflow = Workflow.make(
  "secrets",
  { description: "", input: Schema.Struct({}) },
  Effect.fn(function* secrets() {
    const token = yield* Secret("api-token");
    const call = yield* Call("call", { token, url: "https://example.test" });
    return {
      authorized: call.authorized,
      length: Output.map(token, (t) => Redacted.value(t).length),
    };
  })
);

const dump = (persisted: unknown) => JSON.stringify(persisted);

afterEach(() => {
  seen.length = 0;
});

const fromEnv = (name: string) =>
  Effect.runPromise(
    SecretStore.use((store) => store.get(name)).pipe(
      Effect.map(Redacted.value),
      Effect.provide(SecretStore.env),
      Effect.result
    )
  );

describe("SecretStore", () => {
  test("fromRecord labels values with their name", async () => {
    const redacted = await Effect.runPromise(
      SecretStore.use((store) => store.get("a")).pipe(
        Effect.provide(SecretStore.fromRecord({ a: "1" }))
      )
    );
    expect(Redacted.value(redacted)).toBe("1");
    expect(redacted.label).toBe("a");
    expect(String(redacted)).not.toContain("1");
  });

  test("env looks up the exact name, then upper snake case", async () => {
    process.env.EFFECTORY_TEST_GH_WEBHOOK = "upper";
    process.env["effectory-exact"] = "exact";
    try {
      expect(await fromEnv("effectory-test-gh-webhook")).toMatchObject({
        success: "upper",
      });
      expect(await fromEnv("effectoryTestGhWebhook")).toMatchObject({
        success: "upper",
      });
      expect(await fromEnv("effectory-exact")).toMatchObject({
        success: "exact",
      });
      const missing = await fromEnv("effectory-missing");
      expect(missing._tag).toBe("Failure");
      expect(missing).toMatchObject({
        failure: { _tag: "SecretNotFound", secret: "effectory-missing" },
      });
    } finally {
      delete process.env.EFFECTORY_TEST_GH_WEBHOOK;
      delete process.env["effectory-exact"];
    }
  });

  test("envName", () => {
    expect(envName("gh-webhook")).toBe("GH_WEBHOOK");
    expect(envName("ghWebhook")).toBe("GH_WEBHOOK");
    expect(envName("api.token v2")).toBe("API_TOKEN_V2");
  });
});

describe("Secret", () => {
  test("passes Redacted values to Actions and never persists them", async () => {
    const { nodes, records, summary } = await runWith(
      SecretStore.fromRecord({ "api-token": value }),
      Effect.gen(function* secretRun() {
        const engine = yield* Engine.Engine;
        const state = yield* State.State;
        const ran = yield* engine.run(workflow, {}, options);
        return {
          nodes: yield* state.getNodes(ran.run.id),
          records: yield* state.records({ collection: "test" }),
          summary: ran,
        };
      })
    );
    expect(summary.run.status).toBe("succeeded");
    expect(summary.run.result).toEqual({
      authorized: true,
      length: value.length,
    });
    expect(seen).toEqual([value]);
    const secretNode = nodes.find((node) => node.kind === "secret");
    expect(secretNode).toMatchObject({
      fqn: "secrets/secret.api-token",
      type: "Secret",
      value: { secret: "api-token" },
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.input).toEqual({
      token: { secret: "api-token" },
      url: "https://example.test",
    });
    for (const persisted of [nodes, records, summary]) {
      expect(dump(persisted)).not.toContain(value);
    }
  });

  test("a missing secret fails its node and skips dependents", async () => {
    const summary = await runWith(
      SecretStore.fromRecord({}),
      Effect.flatMap(Engine.Engine, (engine) =>
        engine.run(workflow, {}, options)
      )
    );
    expect(summary.run.status).toBe("failed");
    const byFqn = new Map(summary.nodes.map((node) => [node.fqn, node]));
    expect(byFqn.get("secrets/secret.api-token")?.error?.tag).toBe(
      "SecretNotFound"
    );
    expect(byFqn.get("secrets/call")?.status).toBe("skipped");
  });

  test("as overrides the node name", async () => {
    const named = Workflow.make(
      "named",
      { description: "", input: Schema.Struct({}) },
      () => Secret("x/y", { as: "custom" })
    );
    const summary = await runWith(
      SecretStore.fromRecord({ "x/y": "v" }),
      Effect.flatMap(Engine.Engine, (engine) => engine.run(named, {}, options))
    );
    expect(summary.nodes.map((node) => node.fqn)).toEqual(["named/custom"]);
    expect(summary.run.result).toEqual({ secret: "x/y" });
  });
});

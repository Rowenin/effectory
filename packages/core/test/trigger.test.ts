import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { Data, Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";

import { SecretStore } from "../src/secret.ts";
import * as Target from "../src/target.ts";
import * as Trigger from "../src/trigger.ts";
import * as Workflow from "../src/workflow.ts";

const verify = Workflow.make(
  "verify",
  {
    description: "",
    input: Schema.Struct({
      pr: Schema.Finite,
      repo: Schema.Struct({ name: Schema.String }),
    }),
  },
  (input) => Effect.succeed(input)
);
const app = Target.make(verify, "app", { repo: { name: "app" } });

class EngineDown extends Data.TaggedError("EngineDown")<{
  readonly message: string;
}> {}

interface Dispatched {
  readonly workflow: string;
  readonly input: unknown;
  readonly meta: unknown;
}

const recorder = () => {
  const calls: Dispatched[] = [];
  const dispatch: Trigger.Dispatch = (workflow, input, meta) =>
    Effect.sync(() => {
      calls.push({ input, meta, workflow: workflow.name });
      return `run-${calls.length}`;
    });
  return { calls, dispatch };
};

const sign = (secret: string, body: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("Trigger definitions", () => {
  test("schedule validates cron and names itself", () => {
    const nightly = Trigger.schedule("0 3 * * *", app);
    expect(nightly).toMatchObject({
      _tag: "Schedule",
      input: { repo: { name: "app" } },
      name: "app@0 3 * * *",
      target: app,
    });
    expect(
      Trigger.schedule("*/5 * * * *", { input: { pr: 1 }, workflow: verify })
        .name
    ).toBe("verify@*/5 * * * *");
    expect(() => Trigger.schedule("not a cron", app)).toThrow("Invalid cron");
    expect(() => Trigger.schedule("61 * * * *", app)).toThrow("Invalid cron");
  });

  test("nextFire computes the next occurrence after now", () => {
    const now = Date.UTC(2026, 0, 1, 2, 59, 30);
    const cron = Trigger.schedule("0 3 * * *", app, {
      timezone: "UTC",
    }).schedule;
    expect(Trigger.nextFire(cron, now).toISOString()).toBe(
      "2026-01-01T03:00:00.000Z"
    );
    expect(Trigger.nextFire(cron, Date.UTC(2026, 0, 1, 3)).toISOString()).toBe(
      "2026-01-02T03:00:00.000Z"
    );
  });

  test("webhook normalizes the route and requires a destination", () => {
    const hook = Trigger.webhook({ map: () => ({}), route: "gh", target: app });
    expect(hook).toMatchObject({ name: "/gh", route: "/gh", workflow: verify });
  });
});

describe("Trigger.serve", () => {
  const triggers = [
    Trigger.webhook({
      map: (event) => {
        const { action, number } = event as { action: string; number: number };
        return action === "opened" ? { pr: number } : undefined;
      },
      route: "/github",
      target: app,
      verify: Trigger.githubSignature("gh-webhook"),
    }),
    Trigger.webhook({
      map: (event) => event,
      name: "open",
      route: "/open",
      workflow: verify,
    }),
  ];

  test("verifies, maps, and dispatches webhook deliveries", async () => {
    const { calls, dispatch } = recorder();
    const responses = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* serveTest() {
          const server = yield* Trigger.serve(triggers, {
            dispatch,
            hostname: "127.0.0.1",
            port: 0,
          });
          const post = (
            route: string,
            body: string,
            headers: Record<string, string> = {}
          ) =>
            Effect.promise(async () => {
              const response = await fetch(
                `http://127.0.0.1:${server.port}${route}`,
                { body, headers, method: "POST" }
              );
              const text = await response.text();
              return { body: text, status: response.status };
            });
          const opened = JSON.stringify({ action: "opened", number: 12 });
          const closed = JSON.stringify({ action: "closed", number: 12 });
          return {
            badSignature: yield* post("/github", opened, {
              "x-hub-signature-256": sign("wrong", opened),
            }),
            ignored: yield* post("/github", closed, {
              "x-hub-signature-256": sign("hush", closed),
            }),
            invalidJson: yield* post("/open", "{"),
            missingSignature: yield* post("/github", opened),
            ok: yield* post("/github", opened, {
              "X-Hub-Signature-256": sign("hush", opened),
            }),
            open: yield* post("/open", JSON.stringify({ pr: 1 })),
            unknown: yield* post("/nope", "{}"),
            wrongMethod: yield* Effect.promise(() =>
              fetch(`http://127.0.0.1:${server.port}/open`).then(
                (response) => response.status
              )
            ),
          };
        })
      ).pipe(Effect.provide(SecretStore.fromRecord({ "gh-webhook": "hush" })))
    );
    expect(responses.ok).toEqual({
      body: JSON.stringify({ runId: "run-1" }),
      status: 202,
    });
    expect(responses.badSignature.status).toBe(401);
    expect(responses.missingSignature.status).toBe(401);
    expect(responses.ignored).toEqual({ body: "", status: 204 });
    expect(responses.unknown.status).toBe(404);
    expect(responses.invalidJson.status).toBe(400);
    expect(responses.wrongMethod).toBe(405);
    expect(responses.open.status).toBe(202);
    expect(calls).toEqual([
      {
        input: { pr: 12, repo: { name: "app" } },
        meta: { target: "app", trigger: "/github" },
        workflow: "verify",
      },
      { input: { pr: 1 }, meta: { trigger: "open" }, workflow: "verify" },
    ]);
  });

  test("answers 500 when dispatch fails", async () => {
    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* failingDispatch() {
          const server = yield* Trigger.serve(triggers, {
            dispatch: () =>
              Effect.fail(new EngineDown({ message: "engine down" })),
            port: 0,
          });
          return yield* Effect.promise(() =>
            fetch(`http://localhost:${server.port}/open`, {
              body: "{}",
              method: "POST",
            }).then((response) => response.status)
          );
        })
      ).pipe(Effect.provide(SecretStore.fromRecord({})))
    );
    expect(status).toBe(500);
  });

  test("rejects duplicate routes", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Trigger.serve([triggers[1], triggers[1]] as Trigger.Trigger[], {
          dispatch: () => Effect.succeed("x"),
          port: 0,
        })
      ).pipe(Effect.provide(SecretStore.fromRecord({})), Effect.result)
    );
    expect(result).toMatchObject({ failure: { _tag: "InvalidTrigger" } });
  });

  test("fires schedules at their cron times", async () => {
    const { calls, dispatch } = recorder();
    const everyMinute = Trigger.schedule("* * * * *", {
      input: { pr: 3, repo: { name: "x" } },
      workflow: verify,
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* scheduleTest() {
          yield* TestClock.setTime(Date.UTC(2026, 0, 1, 0, 0, 30));
          yield* Trigger.serve([everyMinute], { dispatch, port: 0 });
          yield* TestClock.adjust("29 seconds");
          expect(calls).toHaveLength(0);
          yield* TestClock.adjust("1 second");
          expect(calls).toHaveLength(1);
          yield* TestClock.adjust("2 minutes");
          expect(calls).toHaveLength(3);
        })
      ).pipe(
        Effect.provide(
          Layer.mergeAll(TestClock.layer(), SecretStore.fromRecord({}))
        )
      )
    );
    expect(calls[0]).toEqual({
      input: { pr: 3, repo: { name: "x" } },
      meta: { trigger: "verify@* * * * *" },
      workflow: "verify",
    });
  });
});

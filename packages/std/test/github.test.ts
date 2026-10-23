import { describe, expect, test } from "bun:test";

import { Engine, State, Test, Workflow } from "@effectory/core";
import { Effect, Layer, Schema } from "effect";

import * as GitHub from "../src/github.ts";

const cases = {
  create: { body: "first", number: 12, owner: "acme", repo: "app" },
  replace: { body: "second", number: 13, owner: "acme", repo: "app" },
  update: { body: "second", number: 12, owner: "acme", repo: "app" },
};

const engineLayer = Engine.layer.pipe(Layer.provideMerge(State.memory));

const summary = Workflow.make(
  "verify-pr",
  {
    description: "Post a summary comment",
    input: Schema.Struct({ body: Schema.String, pr: Schema.Int }),
    scope: ({ pr }) => `acme/app#${pr}`,
  },
  ({ body, pr }) =>
    GitHub.PullRequestComment("summary", {
      body,
      number: pr,
      owner: "acme",
      repo: "app",
    })
);

/** Run `summary` in live mode against `api` on a fresh in-memory State. */
const runLive = (api: GitHub.MemoryApi, inputs: readonly { body: string }[]) =>
  Effect.runPromise(
    Effect.gen(function* runSummaries() {
      const engine = yield* Engine.Engine;
      const results = [];
      for (const input of inputs) {
        results.push(
          yield* engine.run(
            summary,
            { ...input, pr: 12 },
            { collection: "test", mode: "live", revision: "r1" }
          )
        );
      }
      return results;
    }).pipe(
      Effect.provide(
        Layer.merge(
          engineLayer,
          GitHub.PullRequestCommentProvider.pipe(Layer.provide(api.layer))
        )
      )
    )
  );

describe("GitHub.PullRequestComment", () => {
  test("Test.provider: the live provider over an in-memory GitHub", async () => {
    const api = GitHub.memoryApi();
    const report = await Effect.runPromise(
      Test.provider(GitHub.PullRequestComment, {
        cases,
        layer: GitHub.PullRequestCommentProvider.pipe(Layer.provide(api.layer)),
        mode: "live",
      })
    );
    expect(report.steps.map((step) => step.name)).toEqual([
      "create",
      "noop",
      "update",
      "replace",
      "delete",
      "recover",
    ]);
    expect(api.comments()).toEqual([]);
    expect(api.requests).toContain("GET /repos/acme/app/issues/12/comments");
    expect(api.requests).toContain(
      "PATCH /repos/acme/app/issues/comments/1001"
    );
  });

  test("Test.provider: fake mode", async () => {
    const fake = GitHub.memoryApi();
    const report = await Effect.runPromise(
      Test.provider(GitHub.PullRequestComment, {
        cases,
        layer: GitHub.makePullRequestCommentProvider({ fake }).pipe(
          Layer.provide(GitHub.memoryApi().layer)
        ),
      })
    );
    expect(report.steps).toHaveLength(6);
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.comments()).toEqual([]);
  });

  test("reruns edit one marked comment; a lost state row finds it again", async () => {
    const api = GitHub.memoryApi();
    api.seed({ body: "someone else", number: 12, owner: "acme", repo: "app" });
    const [first, second] = await runLive(api, [
      { body: "1 failure" },
      { body: "all green" },
    ]);
    expect(first?.run.status).toBe("succeeded");
    expect(second?.run.status).toBe("succeeded");
    const ours = api.comments().filter((comment) => comment.id !== 1001);
    expect(ours).toHaveLength(1);
    expect(ours[0]?.body).toBe(
      `all green\n\n${GitHub.marker("acme/app#12", "verify-pr/summary")}`
    );
    expect(second?.run.result).toEqual({
      commentId: ours[0]?.id,
      url: `https://github.com/acme/app/pull/12#issuecomment-${ours[0]?.id}`,
    });

    // A fresh State (no row): read finds the comment by its marker.
    const [third] = await runLive(api, [{ body: "again" }]);
    expect(third?.run.status).toBe("succeeded");
    expect(api.comments()).toHaveLength(2);
    expect(api.comments()[1]?.body.startsWith("again")).toBe(true);
  });

  test("read and delete treat 404 as absent", async () => {
    const api = GitHub.memoryApi();
    const service = GitHub.liveService;
    const input = {
      fqn: "f",
      olds: cases.create,
      output: { commentId: 42, url: "" },
      scope: "s",
    };
    const found = await Effect.runPromise(
      service.read(input).pipe(Effect.provide(api.layer))
    );
    expect(found).toBeUndefined();
    await Effect.runPromise(
      service.delete(input).pipe(Effect.provide(api.layer))
    );
    const recreated = await Effect.runPromise(
      service
        .reconcile({ ...input, news: cases.update })
        .pipe(Effect.provide(api.layer))
    );
    expect(recreated.commentId).not.toBe(42);
    expect(api.comments()).toHaveLength(1);
  });

  test("read without output pages through comments for the marker", async () => {
    const api = GitHub.memoryApi();
    const where = { number: 12, owner: "acme", repo: "app" };
    for (let index = 0; index < 150; index += 1) {
      api.seed({ ...where, body: `noise ${index}` });
    }
    const ours = api.seed({
      ...where,
      body: `mine\n\n${GitHub.marker("s", "f")}`,
    });
    const found = await Effect.runPromise(
      GitHub.liveService
        .read({ fqn: "f", olds: cases.create, output: undefined, scope: "s" })
        .pipe(Effect.provide(api.layer))
    );
    expect(found).toEqual({
      commentId: ours.id,
      url: `https://github.com/acme/app/pull/12#issuecomment-${ours.id}`,
    });
    expect(
      api.requests.filter((request) => request.startsWith("GET"))
    ).toHaveLength(2);
  });

  test("the marker cannot close the HTML comment early", () => {
    expect(GitHub.marker("a-->b", "x")).toBe("<!-- effectory:a-⁠->b:x -->");
  });
});

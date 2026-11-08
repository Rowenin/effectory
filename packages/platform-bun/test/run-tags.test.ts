/* oxlint-disable unicorn/no-await-expression-member -- Assertions inspect completed store results. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { RunSummary, RunWatchFrame } from "@effectory/runtime/history-protocol";
import { Run } from "@effectory/runtime/protocol";
import { Tag, Workflow, WorkflowSchedule } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

import { createStore } from "../src/host-store.ts";

const lease = { assertActive: () => {}, token: "test" };
const submit = (requestKey: string) => ({
  input: null,
  kind: "task" as const,
  requestKey,
  targetId: "inspect",
});

test("run tags persist in get/list/watch and request-key fingerprints", async () => {
  const database = new Database(":memory:");
  try {
    const store = createStore(database, lease);
    await Effect.runPromise(
      Effect.gen(function* () {
        const request = { ...submit("one"), tags: { build: "042" } };
        const run = yield* store.submit(
          { ...request, resolvedTags: { build: "042", team: "platform" } },
          "revision",
          "owner"
        );
        expect(run.tags).toEqual({ build: "042", team: "platform" });
        expect((yield* store.getRun(run.runId)).tags).toEqual(run.tags);
        expect(
          (yield* store.history({ tags: { build: "042" } }, "owner")).items[0]
            ?.tags
        ).toEqual(run.tags);
        const observation = yield* store.observation(run.runId, "owner");
        expect(observation.run.tags).toEqual(run.tags);
        expect((yield* store.lookupSubmission(request, "owner"))?.runId).toBe(
          run.runId
        );
        const error = yield* store
          .lookupSubmission({ ...request, tags: { build: "42" } }, "owner")
          .pipe(Effect.flip);
        expect(error.code).toBe("Conflict");
        const duplicate = yield* store.submit(
          { ...request, resolvedTags: { team: "changed" } },
          "revision",
          "owner"
        );
        expect(duplicate.tags).toEqual(run.tags);
        const empty = yield* store.submit(submit("empty"), "revision", "owner");
        expect(
          (yield* store.lookupSubmission(
            { ...submit("empty"), tags: {} },
            "owner"
          ))?.runId
        ).toBe(empty.runId);
        expect(
          (yield* store.history({ tags: { build: "42" } }, "owner")).items
        ).toEqual([]);
      })
    );
  } finally {
    database.close();
  }
});

test("tag conjunction uses indexed SQL before the 10000-row scan budget", async () => {
  const database = new Database(":memory:");
  try {
    const store = createStore(database, lease);
    database.transaction(() => {
      const insert = database.query(
        "INSERT INTO host_runs(runId,kind,targetId,revision,inputJson,principal,requestKey,fingerprint,status,acceptedAt) VALUES (?, 'task','inspect','revision','null','owner',?,'','Succeeded',?)"
      );
      for (let i = 0; i < 10_002; i += 1) {
        insert.run(
          `run-${i}`,
          `key-${i}`,
          new Date(1_700_000_000_000 + i).toISOString()
        );
      }
      database
        .query("UPDATE host_runs SET tagsJson=? WHERE runId='run-0'")
        .run('{"deployment":"42","team":"platform"}');
      database
        .query(
          "INSERT INTO host_run_tags VALUES ('run-0','owner','deployment','42'),('run-0','owner','team','platform')"
        )
        .run();
    })();
    const page = await Effect.runPromise(
      store.history({ tags: { deployment: "42", team: "platform" } }, "owner")
    );
    expect(page.items.map((item) => item.runId)).toEqual(["run-0"]);
    expect(
      (
        await Effect.runPromise(
          store.history(
            { tags: { deployment: "42", team: "different" } },
            "owner"
          )
        )
      ).items
    ).toEqual([]);
    const plan = database
      .query(
        "EXPLAIN QUERY PLAN SELECT runId FROM host_run_tags WHERE principal=? AND key=? AND value=?"
      )
      .all("owner", "deployment", "42");
    expect(JSON.stringify(plan)).toContain("host_run_tags_lookup");
  } finally {
    database.close();
  }
});

test("legacy tag-column migration backfills empty labels and keeps receipts", async () => {
  const database = new Database(":memory:");
  try {
    const original = createStore(database, lease);
    const run = await Effect.runPromise(
      original.submit(submit("legacy"), "revision", "owner")
    );
    database.exec("ALTER TABLE host_runs DROP COLUMN tagsJson");
    const upgraded = createStore(database, lease);
    expect((await Effect.runPromise(upgraded.getRun(run.runId))).tags).toEqual(
      {}
    );
    expect(
      (
        await Effect.runPromise(
          upgraded.lookupSubmission(submit("legacy"), "owner")
        )
      )?.runId
    ).toBe(run.runId);
    database
      .query("UPDATE host_runs SET tagsJson=? WHERE runId=?")
      .run('{"bad:key":"x"}', run.runId);
    const error = await Effect.runPromise(
      upgraded.getRun(run.runId).pipe(Effect.flip)
    );
    expect(error.code).toBe("Unavailable");
  } finally {
    database.close();
  }
});

test("older untagged replies decode as empty metadata but malformed present values fail", () => {
  const summary = {
    acceptedAt: "now",
    kind: "task",
    lastSequence: 0,
    revision: "revision",
    runId: "run",
    status: "Queued",
    targetId: "task",
  };
  expect(Schema.decodeUnknownSync(RunSummary)(summary).tags).toEqual({});
  expect(
    Schema.decodeUnknownSync(RunWatchFrame)({ _tag: "Snapshot", run: summary })
      ._tag
  ).toBe("Snapshot");
  const run = {
    ...summary,
    engineId: null,
    error: null,
    input: null,
    requestKey: "key",
    result: null,
  };
  expect(Schema.decodeUnknownSync(Run)(run).tags).toEqual({});
  for (const tags of [undefined, null, { build: 42 }, { "bad:key": "x" }]) {
    expect(() => Schema.decodeUnknownSync(Run)({ ...run, tags })).toThrow();
  }
});

test("optional declarations and schedule overrides use the root codec", () => {
  const Build = Tag.make("build", Schema.Int);
  const LooseBuild = Tag.make("build", Schema.String);
  const workflow = Workflow.make(
    {
      error: Schema.Never,
      id: "labels",
      input: Schema.Null,
      success: Schema.Null,
      tags: [Build],
      version: 1,
    },
    Effect.succeed(null)
  );
  expect(
    WorkflowSchedule.make({
      cron: "0 0 * * *",
      id: "daily",
      input: null,
      workflow,
    }).tags
  ).toEqual({});
  expect(() =>
    WorkflowSchedule.make({
      cron: "0 0 * * *",
      id: "daily",
      input: null,
      tags: [LooseBuild("bad")],
      workflow,
    })
  ).toThrow("build");
  expect(
    WorkflowSchedule.make({
      cron: "0 0 * * *",
      id: "daily",
      input: null,
      tags: [Build(42)],
      workflow,
    }).tags
  ).toEqual({ build: "42" });
});

test("tag filter cursors bind conjunctions and principals but ignore key order and empty maps", async () => {
  const database = new Database(":memory:");
  try {
    const store = createStore(database, lease);
    await Effect.runPromise(
      Effect.gen(function* () {
        for (let index = 0; index < 3; index += 1) {
          yield* store.submit(
            {
              ...submit(`cursor-${index}`),
              tags: { build: "042", team: "platform" },
            },
            "revision",
            "owner"
          );
        }
        const first = yield* store.history(
          { limit: 1, tags: { build: "042", team: "platform" } },
          "owner"
        );
        if (first.cursor === null) {
          throw new Error("Expected cursor");
        }
        const next = yield* store.history(
          {
            cursor: first.cursor,
            limit: 1,
            tags: { build: "042", team: "platform" },
          },
          "owner"
        );
        expect(next.items).toHaveLength(1);
        expect(next.items[0]?.runId).not.toBe(first.items[0]?.runId);
        expect(
          (yield* store
            .history(
              { cursor: first.cursor, limit: 1, tags: { team: "platform" } },
              "owner"
            )
            .pipe(Effect.flip)).code
        ).toBe("Conflict");
        expect(
          (yield* store
            .history(
              {
                cursor: first.cursor,
                limit: 1,
                tags: { build: "042", team: "platform" },
              },
              "stranger"
            )
            .pipe(Effect.flip)).code
        ).toBe("Conflict");
        const unfiltered = yield* store.history({ limit: 1 }, "owner");
        if (unfiltered.cursor === null) {
          throw new Error("Expected cursor");
        }
        expect(
          (yield* store.history(
            { cursor: unfiltered.cursor, limit: 1, tags: {} },
            "owner"
          )).items
        ).toHaveLength(1);
      })
    );
  } finally {
    database.close();
  }
});

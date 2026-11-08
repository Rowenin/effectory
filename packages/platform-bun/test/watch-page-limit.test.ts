import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { Effect } from "effect";

import { eventPage } from "../src/inspection.ts";
import { createPagination } from "../src/pagination.ts";
import { guardWatchFrame, watchLineLimit } from "../src/watch-plane.ts";

test("an oversized stored watch event cannot be retrieved through the event page API", async () => {
  const database = new Database(":memory:");
  try {
    database.run(
      "CREATE TABLE host_runs (runId TEXT, principal TEXT, lastSequence INTEGER)"
    );
    database.run(
      "CREATE TABLE host_events (at TEXT, payloadJson TEXT, runId TEXT, sequence INTEGER, tag TEXT)"
    );
    database
      .query("INSERT INTO host_runs VALUES (?, ?, ?)")
      .run("run", "owner", 1);
    const event = {
      at: new Date(0).toISOString(),
      payload: { nodeId: "x".repeat(watchLineLimit) },
      runId: "run",
      sequence: 1,
      tag: "AttemptStarted",
    };
    database
      .query("INSERT INTO host_events VALUES (?, ?, ?, ?, ?)")
      .run(
        event.at,
        JSON.stringify(event.payload),
        event.runId,
        event.sequence,
        event.tag
      );
    const failure = await Effect.runPromise(
      guardWatchFrame({ _tag: "Event", event }, "1").pipe(Effect.flip)
    );
    expect(failure.code).toBe("LimitExceeded");
    expect(() =>
      eventPage(
        database,
        createPagination("secret"),
        { afterSequence: 0, limit: 1, runId: "run" },
        "owner"
      )
    ).toThrow("Event exceeds page byte limit");
    expect(
      database.query("SELECT COUNT(*) AS count FROM host_events").get()
    ).toEqual({ count: 1 });
  } finally {
    database.close();
  }
});

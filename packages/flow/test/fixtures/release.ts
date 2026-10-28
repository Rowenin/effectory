/**
 * One durable-run command per process, for tests that span processes:
 *
 *   bun release.ts <db> <events> start
 *   bun release.ts <db> <events> resume <runId> [responses as JSON]
 *   bun release.ts <db> <events> status <runId>
 *
 * Prints one JSON line. Work appends to the <events> file so tests can see
 * what ran in which process. HANG=deploy makes Deploy hang after starting;
 * LEASE_MS sets the lease time.
 */
import { appendFileSync } from "node:fs";

import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Duration, Effect, Layer, Schema } from "effect";

import { Flow } from "../../src/index.ts";

const [db = "", events = "", command, runId = "", responses] =
  process.argv.slice(2);
const record = (event: string) =>
  Effect.sync(() => appendFileSync(events, `${event}\n`));

const Build = Flow.Task(
  "Build",
  { input: Schema.Void, output: Schema.String },
  () => Effect.succeed({ run: Effect.as(record("build"), "artifact") })
);

const Confirm = Flow.Input("Confirm", {
  input: Schema.String,
  output: Schema.Boolean,
});

const Deploy = Flow.Task(
  "Deploy",
  { input: Schema.Void, output: Schema.String },
  () =>
    Effect.gen(function* deploy() {
      const artifact = yield* Flow.After(Build);
      const confirmed = yield* Flow.After(Confirm, "production");
      return {
        run: Effect.gen(function* deployRun() {
          const built = yield* artifact.output;
          yield* confirmed.output;
          yield* record("deploy:start");
          if (process.env["HANG"] === "deploy") {
            return yield* Effect.never;
          }
          yield* record("deploy:end");
          return `deployed ${built}`;
        }),
      };
    })
);

const program = Effect.gen(function* fixture() {
  switch (command) {
    case "start": {
      return yield* Flow.start(Deploy);
    }
    case "resume": {
      return yield* Flow.resume(Deploy, runId, {
        responses: responses ? JSON.parse(responses) : {},
      });
    }
    default: {
      return yield* Flow.status(runId);
    }
  }
});

const store = Flow.sqlStore.pipe(
  Layer.provide(SqliteClient.layer({ filename: db })),
  Layer.orDie
);

const result = await Effect.runPromise(
  program.pipe(
    Effect.map((value) =>
      "_tag" in value && value._tag === "Failed"
        ? { _tag: "Failed", runId: value.runId }
        : value
    ),
    Effect.catchTag("ResumeError", (error) =>
      Effect.succeed({ error: error.reason })
    ),
    Effect.provideService(
      Flow.LeaseTime,
      Duration.millis(Number(process.env["LEASE_MS"] ?? 30_000))
    ),
    Effect.provide(store)
  )
);
console.log(JSON.stringify(result));

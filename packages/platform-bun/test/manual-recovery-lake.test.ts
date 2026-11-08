import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Artifact } from "@offtree/effectory-sdk";
import { Effect, Exit, Schema } from "effect";

import { bindAttemptEntry } from "../src/attempt-entry.ts";
import { createStore } from "../src/host-store.ts";
import { createLake } from "../src/lake.ts";

test("a held run permits its live sibling's publication and reads, but rejects a superseded entry", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-recovery-lake-")
  );
  const database = new Database(path.join(directory, "state.sqlite"));
  const lease = { assertActive: () => {}, token: "lease" };
  const store = createStore(database, lease);
  const lake = createLake(database, path.join(directory, "blobs"), lease);
  const artifact = Artifact.make({
    id: "value",
    schema: Schema.Int,
    version: 1,
  });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const run = yield* store.submit(
          {
            input: null,
            kind: "workflow",
            requestKey: "run",
            targetId: "flow",
          },
          "pinned",
          "owner"
        );
        const admission = yield* store.reserveAttempt(
          run.runId,
          "sibling",
          1,
          "idempotent"
        );
        const identity = {
          attempt: 1,
          attemptId: `${run.runId}/sibling/1`,
          invocationPath: "sibling",
          revision: "pinned",
          runId: run.runId,
          taskId: "sibling",
          taskVersion: 1,
        };
        bindAttemptEntry(identity, admission.entry);
        yield* store.admitAttempt(run.runId, "manual", 1, "manual");
        yield* store.admitAttempt(run.runId, "manual", 1, "manual");
        expect((yield* store.getRun(run.runId)).status).toBe("NeedsAttention");
        const ref = Schema.decodeUnknownSync(artifact.refSchema)(
          yield* lake.publish(identity, "value", artifact, 42, { key: "same" })
        );
        const binding = lake.reader(identity, () => true);
        expect(yield* binding.reader.get(artifact, ref)).toBe(42);
        // Emulate a later entry fence even if an old handle escapes its scope.
        database
          .query(
            "UPDATE host_attempts SET entries=entries+1 WHERE nodeId='sibling'"
          )
          .run();
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              lake.publish(identity, "value", artifact, 42, { key: "other" })
            )
          )
        ).toBe(true);
        expect(
          Exit.isFailure(yield* Effect.exit(binding.reader.get(artifact, ref)))
        ).toBe(true);
        store.releaseAttempt(run.runId, "sibling", 1, admission);
      })
    );
  } finally {
    database.close();
    await rm(directory, { force: true, recursive: true });
  }
});

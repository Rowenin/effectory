import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Exit, Schema } from "effect";

import { ownershipLayer } from "../src/ownership.ts";
import type { ReclaimPreview } from "../src/revision-reclaim-journal-record.ts";
import { ReclaimProgress } from "../src/revision-reclaim-journal-record.ts";
import { makeReclaimJournal } from "../src/revision-reclaim-journal.ts";
import { assertUpgradeIdle } from "../src/upgrade-transition-gate.ts";

const build = "a".repeat(64);
const revision = "b".repeat(64);
const binding = "c".repeat(64);
const now = Date.parse("2026-11-08T00:00:00.000Z");
function preview(id = crypto.randomUUID()): typeof ReclaimPreview.Type {
  return {
    architecture: process.arch,
    binding,
    format: 1,
    plan: {
      candidates: [
        {
          bundleDigest: "d".repeat(64),
          bytes: 100,
          executionContract: null,
          hostBuild: build,
          manifestDigest: "e".repeat(64),
          revision,
        },
      ],
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 900_000).toISOString(),
      hostBuild: build,
      logicalBytes: 100,
      planId: id,
      projectedRetainedCount: 0,
      protected: [],
      repositoryId: "repository",
      retainedCount: 1,
      scannedBytes: 100,
      scannedRows: 1,
      selector: { _tag: "Unreferenced" },
      status: "Ready",
    },
    platform: process.platform,
  };
}
type Journal = Effect.Success<ReturnType<typeof makeReclaimJournal>>;
async function fixture(
  body: (
    directory: string,
    run: <A, E>(
      f: (j: Journal) => Effect.Effect<A, E>,
      step?: (name: string) => Effect.Effect<void>
    ) => Promise<A>
  ) => Promise<void>
) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "effectory-reclaim-journal-")
  );
  mkdirSync(path.join(directory, ".effectory"));
  const run = <A, E>(
    f: (j: Journal) => Effect.Effect<A, E>,
    step?: (name: string) => Effect.Effect<void>
  ) =>
    Effect.runPromise(
      Effect.flatMap(makeReclaimJournal(directory, step), f).pipe(
        Effect.provide(
          ownershipLayer(path.join(directory, ".effectory/state.sqlite.owner"))
        )
      )
    );
  try {
    await body(directory, run);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("accepted intent survives a failure before its first history record and blocks both current and predecessor routing", () =>
  fixture(async (directory, run) => {
    const value = preview();
    await run((j) => j.save(value, now));
    const exit = await run(
      (j) => Effect.exit(j.accept(value.plan.planId, binding, build, now + 1)),
      () => Effect.die("crash after fsync")
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const gate = path.join(directory, ".effectory/upgrades/active.json");
    const accepted = readFileSync(gate, "utf-8");
    expect(() => assertUpgradeIdle(directory)).toThrow(
      `effectory revision reclaim apply ${value.plan.planId}`
    );
    // This is the predecessor routing decoder, not an actual old executable proof.
    expect(() =>
      Schema.decodeUnknownSync(
        Schema.Struct({
          format: Schema.Literal(1),
          planId: Schema.String,
          targetBuild: Schema.String,
        })
      )(JSON.parse(accepted))
    ).toThrow();
    const inspected = await run((j) => j.inspect(value.plan.planId));
    expect(inspected._tag).toBe("Accepted");
    if (inspected._tag !== "Accepted") {
      throw new Error("Expected accepted intent");
    }
    expect(inspected.transition.progress).toEqual([
      { phase: "Pending", revision },
    ]);
    expect(readFileSync(gate, "utf-8")).toBe(accepted);
    const retried = await run((j) =>
      j.accept(value.plan.planId, "wrong", "wrong", now + 900_001)
    );
    expect(retried).toEqual(inspected.transition);
    const foreign = await run((j) =>
      j
        .advance(value.plan.planId, "f".repeat(64), revision, "Quarantined")
        .pipe(Effect.flip)
    );
    expect(foreign.code).toBe("RevisionUnavailable");
    const skipped = await run((j) =>
      j
        .advance(value.plan.planId, build, revision, "Complete")
        .pipe(Effect.flip)
    );
    expect(skipped.code).toBe("Conflict");
  }));

test("completed receipts replay after expiry and recreation and never clear another maintenance gate", () =>
  fixture(async (directory, run) => {
    const value = preview();
    const id = value.plan.planId;
    await run((j) =>
      Effect.gen(function* () {
        yield* j.save(value, now);
        yield* j.accept(id, binding, build, now + 1);
        for (const phase of ReclaimProgress.literals.slice(1)) {
          yield* j.advance(id, build, revision, phase);
        }
        yield* j.complete(id, build, now + 2);
      })
    );
    expect(() => assertUpgradeIdle(directory)).toThrow(
      "revision reclaim apply"
    );
    const completed = await run((j) => j.release(id, build));
    expect(() => assertUpgradeIdle(directory)).not.toThrow();
    expect(completed.receipt).toEqual({
      completedAt: new Date(now + 2).toISOString(),
      logicalBytes: 100,
      planId: id,
      removedFiles: 2,
      revisions: [revision],
      startedAt: new Date(now + 1).toISOString(),
    });
    const location = path.join(directory, ".effectory/revisions", revision);
    mkdirSync(location, { recursive: true });
    writeFileSync(path.join(location, "application.mjs"), "recreated");
    const foreign = JSON.stringify({
      format: 1,
      planId: crypto.randomUUID(),
      targetBuild: "f".repeat(64),
    });
    writeFileSync(
      path.join(directory, ".effectory/upgrades/active.json"),
      foreign
    );
    const repeated = await run((j) =>
      j.accept(id, "changed", "changed", now + 999_999)
    );
    expect(repeated).toEqual(completed);
    expect(await run((j) => j.release(id, build))).toEqual(completed);
    expect(
      readFileSync(
        path.join(directory, ".effectory/upgrades/active.json"),
        "utf-8"
      )
    ).toBe(foreign);
    expect(readFileSync(path.join(location, "application.mjs"), "utf-8")).toBe(
      "recreated"
    );
  }));

test("refused, expired and empty previews never create an acceptance gate", () =>
  fixture(async (directory, run) => {
    const value = preview();
    await run((j) => j.save(value, now));
    await run((j) =>
      Effect.gen(function* () {
        for (const [identity, host, at] of [
          ["f".repeat(64), build, now],
          [binding, "f".repeat(64), now],
          [binding, build, now + 900_000],
        ] as const) {
          const failure = yield* j
            .accept(value.plan.planId, identity, host, at)
            .pipe(Effect.flip);
          expect(failure.code).toBe("Conflict");
          expect(
            existsSync(path.join(directory, ".effectory/upgrades/active.json"))
          ).toBe(false);
        }
      })
    );
    const empty = preview();
    const noCandidates: typeof ReclaimPreview.Type = {
      ...empty,
      plan: {
        ...empty.plan,
        candidates: [],
        logicalBytes: 0,
        projectedRetainedCount: 1,
        status: "NoCandidates",
      },
    };
    await run((j) => j.save(noCandidates, now));
    const refused = await run((j) =>
      j.accept(empty.plan.planId, binding, build, now).pipe(Effect.flip)
    );
    expect(refused.code).toBe("Conflict");
    expect(
      existsSync(path.join(directory, ".effectory/upgrades/active.json"))
    ).toBe(false);
  }));

test("live previews are bounded, expired previews are removed, and incomplete records are refused", () =>
  fixture(async (directory, run) => {
    await run((j) =>
      Effect.gen(function* () {
        for (let i = 0; i < 32; i += 1) {
          yield* j.save(preview(), now);
        }
        const failure = yield* j.save(preview(), now).pipe(Effect.flip);
        expect(failure.code).toBe("LimitExceeded");
      })
    );
    const fresh = preview();
    await run((j) =>
      j.save(
        {
          ...fresh,
          plan: {
            ...fresh.plan,
            createdAt: new Date(now + 900_000).toISOString(),
            expiresAt: new Date(now + 1_800_000).toISOString(),
          },
        },
        now + 900_000
      )
    );
    const filename = path.join(
      directory,
      ".effectory/revision-reclaims/plans",
      `${fresh.plan.planId}.json`
    );
    const before = readFileSync(filename, "utf-8");
    const unsupported = JSON.parse(before);
    unsupported.format = 2;
    writeFileSync(filename, JSON.stringify(unsupported));
    const failure = await run((j) =>
      j.inspect(fresh.plan.planId).pipe(Effect.flip)
    );
    expect(failure.code).toBe("RevisionUnavailable");
    expect(readFileSync(filename, "utf-8")).toBe(JSON.stringify(unsupported));
  }));

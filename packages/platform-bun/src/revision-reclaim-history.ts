import path from "node:path";

import { Digest } from "@effectory/runtime/extension-protocol";
import { Effect, Schema } from "effect";

import { RepositoryLease } from "./ownership.ts";
import { invalidReclaimRecord } from "./revision-reclaim-journal-record.ts";
import { makeReclaimJournal } from "./revision-reclaim-journal.ts";
import {
  RevisionReclaimId,
  revisionReclaimError,
} from "./revision-reclaim-record.ts";
import { readUpgradeFile, upgradeDirectory } from "./upgrade-record-file.ts";

const Locator = Schema.Struct({
  format: Schema.Literal(1),
  planId: RevisionReclaimId,
  revision: Digest,
});

/** Consult only after the catalog has ruled out a currently verified retained revision. */
export function reclaimedRevisionError(repository: string, revision: string) {
  return Effect.gen(function* () {
    if (!Schema.is(Digest)(revision)) {
      return null;
    }
    const lease = yield* RepositoryLease;
    const locator = yield* Effect.try({
      catch: invalidReclaimRecord,
      try: () => {
        lease.assertActive();
        const control = path.join(
          repository,
          ".effectory",
          "revision-reclaims"
        );
        const deleted = path.join(control, "deleted");
        if (
          !upgradeDirectory(control, false) ||
          !upgradeDirectory(deleted, false)
        ) {
          return null;
        }
        const text = readUpgradeFile(
          path.join(deleted, `${revision}.json`),
          65_536
        );
        if (text === null) {
          return null;
        }
        const value = Schema.decodeUnknownSync(Locator)(JSON.parse(text), {
          onExcessProperty: "error",
        });
        if (value.revision !== revision) {
          throw invalidReclaimRecord();
        }
        return value;
      },
    });
    if (locator === null) {
      return null;
    }
    const journal = yield* makeReclaimJournal(repository);
    const saved = yield* journal.inspect(locator.planId);
    if (
      saved._tag !== "Accepted" ||
      saved.transition.phase !== "Complete" ||
      !saved.transition.receipt?.revisions.includes(revision)
    ) {
      return yield* invalidReclaimRecord();
    }
    return revisionReclaimError(
      "RevisionUnavailable",
      `Application revision ${revision} was reclaimed by plan ${locator.planId}; inspect its receipt with effectory revision reclaim inspect ${locator.planId}`
    );
  });
}

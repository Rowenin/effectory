import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import { canonical } from "@offtree/effectory-sdk/internal/boundary";
import { Effect, Exit, Schema } from "effect";

import { hostAbi } from "./host-runtime.ts";
import { ownershipLayer } from "./ownership.ts";
import {
  assessRevisionReclamation,
  assertReclaimAssessment,
  recheckReclaimCandidates,
} from "./revision-reclaim-assessment.ts";
import { reclaimRevisionFiles } from "./revision-reclaim-executor.ts";
import { makeReclaimJournal } from "./revision-reclaim-journal.ts";
import {
  RevisionReclaimId,
  RevisionReclaimSelector,
  revisionReclaimError,
} from "./revision-reclaim-record.ts";
import { snapshotMarker } from "./snapshot-marker.ts";
import { storageError } from "./storage-error.ts";
import { missingUpgradeFile } from "./upgrade-record-file.ts";

export type RevisionReclaimAction =
  | {
      readonly kind: "Plan";
      readonly selector: typeof RevisionReclaimSelector.Type;
    }
  | { readonly kind: "Apply" | "Inspect"; readonly planId: string };

function location(repository: string, action: RevisionReclaimAction) {
  return Effect.try({
    catch: (cause) =>
      storageError(
        cause,
        "Cannot acquire offline revision reclamation ownership"
      ),
    try: () => {
      if (action.kind === "Plan") {
        const selector = Schema.decodeExit(RevisionReclaimSelector)(
          action.selector,
          { onExcessProperty: "error" }
        );
        if (Exit.isFailure(selector)) {
          throw revisionReclaimError(
            "InvalidInput",
            "Select --unreferenced or one valid --revision digest"
          );
        }
      } else if (!Schema.is(RevisionReclaimId)(action.planId)) {
        throw revisionReclaimError(
          "InvalidInput",
          "Invalid revision reclamation plan ID"
        );
      }
      const root = realpathSync(repository);
      try {
        lstatSync(path.join(root, snapshotMarker));
        throw revisionReclaimError(
          "Conflict",
          "Snapshot is incomplete; finish verified recovery before revision reclamation"
        );
      } catch (error) {
        if (!missingUpgradeFile(error)) {
          throw error;
        }
      }
      const state = path.join(root, ".effectory");
      if (!lstatSync(state).isDirectory()) {
        throw revisionReclaimError(
          "InvalidInput",
          "Revision reclamation requires a real initialized state directory"
        );
      }
      const owner = path.join(state, "state.sqlite.owner");
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try {
          const stat = lstatSync(owner + suffix);
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576) {
            throw revisionReclaimError(
              "InvalidInput",
              "Reclamation ownership files must be bounded single-link regular files"
            );
          }
        } catch (error) {
          if (!missingUpgradeFile(error)) {
            throw error;
          }
        }
      }
      return { owner, root };
    },
  });
}

/** Offline only. Accepted replay bypasses preview recapture, never accepting-host ownership. */
export function reclaimRevisions(
  repository: string,
  action: RevisionReclaimAction,
  step: (name: string) => Effect.Effect<void> = () => Effect.void
) {
  return Effect.gen(function* () {
    const { root, owner } = yield* location(repository, action);
    return yield* Effect.gen(function* () {
      const journal = yield* makeReclaimJournal(root, step);
      if (action.kind === "Plan") {
        const preview = yield* assessRevisionReclamation(
          root,
          action.selector,
          crypto.randomUUID()
        );
        yield* journal.save(preview, Date.now());
        return preview.plan;
      }
      const saved = yield* journal.inspect(action.planId);
      if (action.kind === "Inspect") {
        return saved._tag === "Planned"
          ? {
              completedRevisions: 0,
              phase: "Planned" as const,
              plan: saved.preview.plan,
              receipt: null,
            }
          : {
              completedRevisions: saved.transition.progress.filter(
                (item) => item.phase === "Complete"
              ).length,
              phase: saved.transition.phase,
              plan: saved.transition.preview.plan,
              receipt: saved.transition.receipt,
            };
      }
      if (saved._tag === "Planned") {
        if (
          saved.preview.plan.status !== "Ready" ||
          Date.parse(saved.preview.plan.expiresAt) <= Date.now() ||
          saved.preview.plan.hostBuild !== hostAbi()
        ) {
          return yield* revisionReclaimError(
            "Conflict",
            "Revision reclamation preview is not applicable, expired or belongs to another host; plan again"
          );
        }
        yield* recheckReclaimCandidates(root, saved.preview);
        const current = yield* assessRevisionReclamation(
          root,
          saved.preview.plan.selector,
          action.planId
        );
        yield* Effect.try({
          catch: (cause) =>
            storageError(
              cause,
              "Cannot revalidate revision reclamation preview"
            ),
          try: () => assertReclaimAssessment(saved.preview, current),
        });
        // Re-read the saved bytes as well: the acceptance must name the exact
        // independently checked preview, even if a noncooperating writer edits it.
        const checked = yield* journal.inspect(action.planId);
        if (
          checked._tag !== "Planned" ||
          canonical(checked.preview) !== canonical(saved.preview)
        ) {
          return yield* revisionReclaimError(
            "Conflict",
            "Revision reclamation preview changed during admission"
          );
        }
        yield* journal.accept(
          action.planId,
          current.binding,
          hostAbi(),
          Date.now()
        );
      }
      return yield* reclaimRevisionFiles(root, action.planId, hostAbi(), step);
    }).pipe(
      Effect.provide(ownershipLayer(owner)),
      Effect.scoped,
      Effect.catchTag("RepositoryBusy", () =>
        Effect.fail(
          revisionReclaimError(
            "Conflict",
            "Repository is owned by another process; stop the compatible daemon before revision reclamation"
          )
        )
      )
    );
  });
}

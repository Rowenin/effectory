/* oxlint-disable no-loop-func -- Each synchronous page completes before the next Effect yield. */
import type { Database } from "bun:sqlite";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect, Schema } from "effect";

import type { InspectionBudget } from "./inspection-budget.ts";
import { upgradePage } from "./upgrade-page.ts";

const Position = Schema.Struct({ position: Schema.Int });

export const unsupportedUpgradeWork = (category: string) =>
  new OperationError({
    code: "RevisionUnavailable",
    message: `Unsupported or inconsistent ${category}; preserve the repository and use its compatible host. No recovery work was performed.`,
  });

/** One shared budget; queries must keyset-page by an indexed integer position. */
export function upgradeScanner(database: Database, budget?: InspectionBudget) {
  let rows = 0;
  let bytes = 0;
  return {
    scan: (
      category: string,
      // SQL and validators are host constants, never operator input.
      sql: string,
      visit: (row: unknown) => void,
      positionColumn = "position"
    ) =>
      Effect.gen(function* () {
        let position: number | null = null;
        for (;;) {
          const more = yield* Effect.try({
            catch: (cause) =>
              cause instanceof OperationError &&
              (cause.code === "RevisionUnavailable" ||
                cause.code === "LimitExceeded")
                ? cause
                : unsupportedUpgradeWork(category),
            try: () =>
              database.transaction(() => {
                const page = upgradePage(
                  database,
                  sql.replace(
                    "/* after */",
                    position === null ? "1" : `${positionColumn} > ?`
                  ),
                  position === null ? [] : [position]
                );
                for (const row of page.rows) {
                  const current =
                    Schema.decodeUnknownSync(Position)(row).position;
                  if (
                    !Number.isSafeInteger(current) ||
                    current < 1 ||
                    (position !== null && current <= position)
                  ) {
                    throw unsupportedUpgradeWork(category);
                  }
                  rows += 1;
                  bytes += Buffer.byteLength(JSON.stringify(row));
                  if (rows > 1_000_000 || bytes > 268_435_456) {
                    throw new OperationError({
                      code: "LimitExceeded",
                      message:
                        "Upgrade journal inspection exceeds one million rows or 256 MiB; complete recovery with the compatible host before upgrading",
                    });
                  }
                  budget?.visit(category, row);
                  visit(row);
                  position = current;
                }
                return page.more;
              })(),
          });
          if (!more) {
            return;
          }
          yield* Effect.yieldNow;
        }
      }),
    get totals() {
      return { bytes, rows };
    },
  };
}

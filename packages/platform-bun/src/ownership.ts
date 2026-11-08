import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";

import { Context, Effect, Layer, Schema } from "effect";

/* oxlint-disable unicorn/throw-new-error */
class RepositoryBusy extends Schema.TaggedError<
  RepositoryBusy,
  { readonly brand: unique symbol }
>()("RepositoryBusy", {
  message: Schema.String,
}) {}

export interface Lease {
  readonly token: string;
  readonly assertActive: () => void;
}

// SQLite's OS-managed lock is released on process death, without PID guessing
// or a racy stale-lock-file takeover. This database is separate from run storage.
export const RepositoryLease = Context.Service<Lease>(
  "effectory/RepositoryLease"
);

export function ownershipLayer(filename: string) {
  return Layer.effect(
    RepositoryLease,
    Effect.acquireRelease(
      Effect.try({
        catch: () =>
          new RepositoryBusy({
            message:
              "Repository is owned by another process or its ownership file is unavailable",
          }),
        try: () => {
          const database = new Database(filename, { create: true });
          try {
            chmodSync(filename, 0o600);
            database.run("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
            let active = true;
            return {
              assertActive: () => {
                if (!active) {
                  throw new RepositoryBusy({
                    message: "Repository ownership has ended",
                  });
                }
              },
              release: () => {
                active = false;
                database.run("ROLLBACK");
                database.close();
              },
              token: crypto.randomUUID(),
            };
          } catch (error) {
            database.close();
            throw error;
          }
        },
      }),
      (lease) => Effect.sync(() => lease.release())
    )
  );
}

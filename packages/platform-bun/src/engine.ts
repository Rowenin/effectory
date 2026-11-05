import { BunCrypto } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Layer, Option } from "effect";
import {
  ClusterWorkflowEngine,
  RunnerAddress,
  SingleRunner,
} from "effect/cluster";

import { RepositoryLease } from "./ownership.ts";

/** The caller must hold the repository's exclusive ownership for this Layer's lifetime. */
export function engineLayer(filename: string) {
  return Layer.unwrap(
    Effect.map(RepositoryLease, (lease) => {
      lease.assertActive();
      return ClusterWorkflowEngine.layer.pipe(
        Layer.provideMerge(
          SingleRunner.layer({
            // Only runner ownership is in memory. All messages/results remain in SQLite.
            // The repository lock must exclude every other host before this Layer starts.
            runnerStorage: "memory",
            shardingConfig: {
              entityMessagePollInterval: "20 millis",
              entityReplyPollInterval: "20 millis",
              entityTerminationTimeout: "1 second",
              runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", 0)),
            },
          })
        ),
        Layer.provideMerge(SqliteClient.layer({ filename })),
        Layer.provide(BunCrypto.layer)
      );
    })
  );
}

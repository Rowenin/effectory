import path from "node:path";

import { Effect, Schema } from "effect";

import {
  normalizeInvocation,
  outputFields,
} from "../../src/invocation-outcome.ts";
import {
  nativeHistoryLayer,
  nativeTaskResult,
} from "../../src/native-history.ts";
import { ownershipLayer } from "../../src/ownership.ts";
import { withRuntimeInspection } from "../../src/upgrade-storage.ts";

const [repository] = process.argv.slice(2);
const ids = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
  JSON.parse(process.argv[3] ?? "null")
);
if (repository === undefined) {
  throw new Error("Missing fixture repository");
}
const state = path.join(repository, ".effectory", "state.sqlite");
const output = await Effect.runPromise(
  withRuntimeInspection(state, ({ filename }) =>
    Effect.forEach(ids, (id) =>
      nativeTaskResult(id).pipe(
        Effect.map((native) =>
          outputFields(
            normalizeInvocation(native, {
              fenced: false,
              reason: null,
              status: "Succeeded",
            })
          )
        )
      )
    ).pipe(Effect.provide(nativeHistoryLayer(filename)))
  ).pipe(Effect.scoped, Effect.provide(ownershipLayer(`${state}.owner`)))
);
process.stdout.write(JSON.stringify(output));

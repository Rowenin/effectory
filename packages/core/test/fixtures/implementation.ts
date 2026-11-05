import { Effect } from "effect";

import { Task } from "../../src/index.ts";
import { InspectRelease } from "./contracts.ts";

export const InspectReleaseLive = Task.implementation(
  { id: "example/inspect-release-live", target: InspectRelease },
  ({ repository }) => Effect.succeed({ notes: repository, version: "v1" })
);

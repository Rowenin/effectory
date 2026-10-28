/** The entry point to this repository's flows; the `flow` CLI loads it. */
import * as BunServices from "@effect/platform-bun/BunServices";
import { Flow } from "@effectory/flow";
import { Layer } from "effect";

import {
  Announce,
  ConfirmRelease,
  Cooldown,
  HeadCommit,
  Publish,
  Release,
} from "./flows/release.ts";
import {
  AgentsFake,
  Approve,
  ApprovePlan,
  Draft,
  Implement,
  Refine,
  Review,
} from "./flows/ship.ts";
import { Shell } from "./flows/tools.ts";
import { Check, Verify } from "./flows/verify.ts";

export default Flow.make({
  concurrency: 4,
  layer: Layer.mergeAll(AgentsFake, Shell.layer).pipe(
    Layer.provideMerge(BunServices.layer)
  ),
  tasks: [
    // Verify the repository with its own tools.
    Verify,
    Check,
    // Release it: verify, confirm with a person, cool down, publish.
    Release,
    HeadCommit,
    ConfirmRelease,
    Cooldown,
    Publish,
    Announce,
    // Plan and implement a change with (fake) agents and a person.
    Implement,
    Approve,
    ApprovePlan,
    Refine,
    Draft,
    Review,
  ],
});

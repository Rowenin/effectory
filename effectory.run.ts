import { Agent, Claude, Process } from "@effectory/activities";
import { Effectory } from "@effectory/sdk";
import { Layer } from "effect";

import approvedHealthCheck from "./.effectory/automations/approved-health-check/index.ts";
import healthCheck from "./.effectory/automations/health-check/index.ts";
import implement from "./.effectory/automations/implement/index.ts";
import planImplement from "./.effectory/automations/plan-implement/index.ts";
import reviewBranch from "./.effectory/automations/review-branch/index.ts";

export default Effectory.make({
  services: Layer.mergeAll(
    Process.layer,
    Agent.make(Claude.make({ model: "claude-haiku-5-5" }))
  ),
  workflows: [
    healthCheck,
    approvedHealthCheck,
    reviewBranch,
    planImplement,
    implement,
  ],
});

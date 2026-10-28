/** The entry point to this repository's flows; the `flow` CLI loads it. */
import { Flow } from "@effectory/flow";

import {
  AgentsFake,
  Approve,
  ApprovePlan,
  Draft,
  Implement,
  Refine,
  Review,
} from "./flows/ship.ts";

export default Flow.make({
  layer: AgentsFake,
  tasks: [Implement, Approve, ApprovePlan, Refine, Draft, Review],
});

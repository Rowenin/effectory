import { Automation } from "@effectory/sdk";
import { Schema } from "effect";

import { HealthInput, observe, Summary } from "./definition.ts";

export default Automation.define({
  description:
    "Check up to twenty HTTP monitors with concurrency bounded at three and publish observations and a summary.",
  error: Schema.String,
  execute: observe,
  idempotencyKey: (input) => input.requestId,
  input: HealthInput,
  name: "health-check",
  success: Summary,
});

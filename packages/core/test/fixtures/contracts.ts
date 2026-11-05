import { Schema } from "effect";

import { Task } from "../../src/index.ts";

// Contract-only module: no handler import or service acquisition.
export const InspectRelease = Task.contract({
  error: Schema.Never,
  id: "example/inspect-release",
  input: Schema.Struct({ repository: Schema.String }),
  replay: "idempotent",
  success: Schema.Struct({ notes: Schema.String, version: Schema.String }),
  version: 1,
});

export const ReleaseTools = Object.freeze({ tasks: { InspectRelease } });

import { Artifact, Task } from "@effectory/core";
import { Context, Schema } from "effect";

export class Client extends Context.Service<
  Client,
  { readonly prefix: string }
>()("fixture/Client") {}
export const Report = Artifact.make({
  id: "fixture/tools/report",
  schema: Schema.Struct({ text: Schema.String }),
  version: 1,
});
export const Inspect = Task.contract({
  error: Schema.TaggedStruct("FetchFailed", { message: Schema.String }),
  id: "fixture/tools/inspect",
  input: Schema.Struct({ repository: Schema.String }),
  outputs: { report: Report },
  replay: "idempotent",
  success: Schema.String,
  version: 1,
});
export const contracts = {
  Client,
  artifacts: { Report },
  id: "fixture/tools",
  tasks: { Inspect },
  version: "1.0.0",
  workflows: {},
};

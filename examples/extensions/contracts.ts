import { Task } from "@offtree/effectory-sdk";
import { Context, Schema } from "effect";

export class ReleaseClient extends Context.Service<
  ReleaseClient,
  { readonly prefix: string }
>()("example/ReleaseClient") {}
export const Inspect = Task.contract({
  error: Schema.Never,
  id: "example/release-tools/inspect",
  input: Schema.Struct({ repository: Schema.String }),
  replay: "idempotent",
  success: Schema.String,
  version: 1,
});
export const Publish = Task.contract({
  error: Schema.Never,
  id: "example/publish",
  input: Schema.String,
  replay: "manual",
  success: Schema.String,
  version: 1,
});
export const ReleaseContracts = {
  ReleaseClient,
  artifacts: {},
  id: "example/release-tools",
  tasks: { Inspect },
  version: "1.0.0",
  workflows: {},
};

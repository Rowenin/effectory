import { Extension, Task } from "@effectory/core";
import { Effect } from "effect";

import { Client, Inspect, Report } from "./contracts.mjs";

Reflect.set(globalThis, Symbol.for("effectory/test/extension-loaded"), true);
export default Extension.make({
  artifacts: { Report },
  id: "fixture/tools",
  tasks: {
    Inspect: Task.make(Inspect.spec, ({ repository }) =>
      Effect.map(Client, (client) => `${client.prefix}/${repository}`)
    ),
  },
  version: "1.0.0",
});

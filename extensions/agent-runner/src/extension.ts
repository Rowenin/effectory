import { Extension, Task } from "@offtree/effectory-sdk";
import { Effect } from "effect";

import {
  AgentRunner,
  contracts,
  Result,
  RunSession,
  Transcript,
} from "./contracts.ts";

const RunSessionLive = Task.make(RunSession.spec, (input, context) =>
  Effect.gen(function* () {
    const runner = yield* AgentRunner;
    const { result, transcript } = yield* runner.run(input, (message) =>
      context.progress({ message })
    );
    yield* context.publish("result", result, { key: "result" });
    if (input.retainTranscript === true) {
      yield* context.publish("transcript", [...transcript], {
        key: "transcript",
      });
    }
    return result;
  })
);
export default Extension.make({
  artifacts: { Result, Transcript },
  id: contracts.id,
  tasks: { RunSession: RunSessionLive },
  version: contracts.version,
});

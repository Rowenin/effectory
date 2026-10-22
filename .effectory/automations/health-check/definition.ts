import { Automation, Task } from "@effectory/sdk";
import { Effect, Schema } from "effect";

import {
  checkHttp,
  HttpCheckConfig,
  HttpCheckResult,
} from "../shared/activities/http-check.ts";

const MonitorName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/u)
);
const Monitor = Schema.Struct({ config: HttpCheckConfig, name: MonitorName });
const Monitors = Schema.Array(Monitor).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(20),
  Schema.makeFilter(
    (monitors) =>
      new Set(monitors.map((monitor) => monitor.name)).size === monitors.length,
    { expected: "unique monitor names" }
  )
);

const payload = {
  concurrency: Schema.optional(
    Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 }))
  ),
  monitors: Monitors,
  requestId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128)
  ),
};
export const HealthInput = Schema.Struct(payload);
export const Observation = Schema.Struct({
  name: MonitorName,
  ...HttpCheckResult.fields,
});
export const Summary = Schema.Struct({
  healthy: Schema.Int,
  observations: Schema.Array(Observation).check(Schema.isMaxLength(20)),
  requestId: Schema.String,
  total: Schema.Int,
  unhealthy: Schema.Int,
});

const checkEndpoint = Task.make({
  error: Schema.String,
  input: Monitor,
  name: "check-endpoint",
  run: (monitor) =>
    checkHttp(monitor.config).pipe(
      Effect.map((result) => ({ name: monitor.name, ...result })),
      Effect.mapError(String)
    ),
  success: Observation,
});

export const observe = Effect.fn("HealthCheck.observe")(function* observe(
  input: typeof HealthInput.Type
) {
  const observations = yield* Effect.forEach(
    input.monitors,
    (monitor) =>
      Effect.gen(function* checkMonitor() {
        const observation = yield* checkEndpoint(monitor, {
          key: monitor.name,
        });
        yield* Automation.publish(`observation-${monitor.name}`, {
          schema: Observation,
          value: observation,
        });
        return observation;
      }),
    { concurrency: input.concurrency ?? 3 }
  );
  const healthy = observations.filter((observation) => observation.ok).length;
  const summary = {
    healthy,
    observations,
    requestId: input.requestId,
    total: observations.length,
    unhealthy: observations.length - healthy,
  };
  yield* Automation.publish("summary", { schema: Summary, value: summary });
  return summary;
});

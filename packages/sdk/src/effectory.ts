import type { BunServices } from "@effect/platform-bun/BunServices";
import type { Layer } from "effect";
import type { HttpClient } from "effect/http/HttpClient";

import type { HostServices } from "./automation.ts";
import type { TaskManifest } from "./manifest.ts";

/** Platform services available while constructing configured layers. */
export type PlatformServices = BunServices | HttpClient;

export type WorkflowRegistration<Services> = Omit<
  TaskManifest,
  "implementation" | "name"
> & {
  readonly name: string;
  readonly implementation: Layer.Layer<never, unknown, HostServices | Services>;
};

export interface Config<Services = never, Error = never> {
  /** Explicit registrations for effectory.run.ts; omitted only by legacy service configuration. */
  readonly workflows?: readonly WorkflowRegistration<NoInfer<Services>>[];
  readonly services: Layer.Layer<Services, Error, PlatformServices>;
}

/** Compose application services with native Effect layers in effectory.run.ts. */
export const make = <Services, Error>(
  config: Config<Services, Error>
): Config<Services, Error> => config;

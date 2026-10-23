import type { BunServices } from "@effect/platform-bun/BunServices";
import { Layer } from "effect";
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

type ServiceFreeConfig = Omit<Config<never, never>, "services"> & {
  readonly services?: never;
};

/** Compose application services; service-free workflows default to Layer.empty. */
export function make(config: ServiceFreeConfig): Config<never, never>;
export function make<Services, Error>(
  config: Config<Services, Error>
): Config<Services, Error>;
export function make<Services, Error>(
  config: Config<Services, Error> | ServiceFreeConfig
): Config<Services, Error> | Config<never, never> {
  if (config.services !== undefined) {
    return config;
  }
  return { ...config, services: Layer.empty };
}

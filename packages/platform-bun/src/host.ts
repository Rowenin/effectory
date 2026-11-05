import { Layer } from "effect";

import type { Catalog } from "./catalog.ts";
import { engineLayer } from "./engine.ts";
import { executionResourcesLayer } from "./execution-resources.ts";
import { hostStoreLayer } from "./host-store.ts";
import { interpreterLayer } from "./interpreter.ts";
import { lakeLayer } from "./lake.ts";
import { ownershipLayer } from "./ownership.ts";
import { runnerLayer } from "./runner.ts";
import { schedulerLayer } from "./scheduler.ts";

export function ownedHostLayer<E, R>(options: {
  readonly database: string;
  readonly blobs: string;
  readonly catalog: Layer.Layer<Catalog, E, R>;
}) {
  const storage = lakeLayer(options.database, options.blobs).pipe(
    Layer.provideMerge(hostStoreLayer(options.database))
  );
  const engine = interpreterLayer.pipe(
    Layer.provideMerge(engineLayer(options.database)),
    Layer.provideMerge(storage),
    Layer.provideMerge(options.catalog),
    Layer.provideMerge(executionResourcesLayer)
  );
  return Layer.merge(runnerLayer, schedulerLayer).pipe(
    Layer.provideMerge(engine)
  );
}

export function hostLayer<E, R>(
  options: Parameters<typeof ownedHostLayer<E, R>>[0]
) {
  return ownedHostLayer(options).pipe(
    Layer.provide(ownershipLayer(`${options.database}.owner`))
  );
}

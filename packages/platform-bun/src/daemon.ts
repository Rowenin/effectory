import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { ControlPlane } from "@effectory/runtime/rpc";
import { TaskRuntimeError } from "@offtree/effectory-sdk";
import { checkJsonBudget } from "@offtree/effectory-sdk/internal/boundary";
import { Effect, Layer, Schema } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { snapshotMarker } from "./backup.ts";
import { contentHandler, contentRequest } from "./content-plane.ts";
import { controlPlaneLayer, ServerIdentity } from "./control-plane.ts";
import {
  extensionManagerLayer,
  recoverExtensionOperations,
} from "./extension-manager.ts";
import { GitHubSourceLive } from "./extension-source.ts";
import { HostStore } from "./host-store.ts";
import { ownedHostLayer } from "./host.ts";
import { ownershipLayer } from "./ownership.ts";
import { revisionCatalogLayer } from "./revisions.ts";
import { rpcWebHandler } from "./rpc-web-handler.ts";
import { runWatcherLayer } from "./run-watch.ts";
import { readStoredCredentials } from "./runtime-storage-format.ts";
import { preflightRuntime } from "./upgrade-preflight.ts";
import { watchHandler, watchRequest } from "./watch-plane.ts";

export const Credentials = Schema.Struct({
  repositoryId: Schema.String,
  token: Schema.String,
});
export const Endpoint = Schema.Struct({
  instanceId: Schema.String,
  pid: Schema.Int,
  url: Schema.String,
});

function credentials(directory: string) {
  const filename = path.join(directory, "credentials.json");
  if (!existsSync(filename)) {
    writeFileSync(
      filename,
      JSON.stringify({
        repositoryId: crypto.randomUUID(),
        token: randomBytes(32).toString("hex"),
      }),
      { flag: "wx", mode: 0o600 }
    );
  }
  chmodSync(filename, 0o600);
  return readStoredCredentials(path.dirname(directory));
}

function authorize(request: Request, token: string, repositoryId: string) {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return (
    supplied.length === expected.length &&
    timingSafeEqual(supplied, expected) &&
    request.headers.get("x-effectory-repository") === repositoryId &&
    request.headers.get("x-effectory-protocol") === "1" &&
    !request.headers.has("origin")
  );
}

function validateRpcPayloads(body: unknown) {
  for (const message of Array.isArray(body) ? body : [body]) {
    if (
      typeof message !== "object" ||
      message === null ||
      Reflect.get(message, "_tag") !== "Request"
    ) {
      continue;
    }
    const tag: unknown = Reflect.get(message, "tag");
    const rpc =
      typeof tag === "string" ? ControlPlane.requests.get(tag) : undefined;
    if (rpc !== undefined) {
      Schema.decodeUnknownSync(rpc.payloadSchema)(
        Reflect.get(message, "payload"),
        { onExcessProperty: "error" }
      );
    }
  }
}

export function serve(
  repository: string,
  options: { readonly onShutdownTimeout: () => void }
) {
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const armShutdown = () => {
    shutdownTimer ??= setTimeout(options.onShutdownTimeout, 2000);
  };
  const directory = path.join(repository, ".effectory");
  const database = path.join(directory, "state.sqlite");
  const program = Effect.gen(function* () {
    if (existsSync(path.join(repository, snapshotMarker))) {
      return yield* new OperationError({
        code: "Unavailable",
        message:
          "Snapshot copy is incomplete; restore to a fresh destination before starting the daemon",
      });
    }
    yield* preflightRuntime(repository);
    const auth = yield* Effect.try({
      catch: () =>
        new OperationError({
          code: "Unavailable",
          message: "Repository credentials are unavailable",
        }),
      try: () => credentials(directory),
    });
    const instanceId = crypto.randomUUID();
    let stopAt = Number.POSITIVE_INFINITY;
    yield* recoverExtensionOperations(repository);
    const runtime = ownedHostLayer({
      blobs: path.join(directory, "blobs"),
      catalog: revisionCatalogLayer(repository),
      database,
    });
    const administration = extensionManagerLayer(
      repository,
      Effect.sync(() => {
        stopAt = Date.now();
      })
    ).pipe(Layer.provideMerge(runtime), Layer.provide(GitHubSourceLive));
    const services = controlPlaneLayer.pipe(
      Layer.provideMerge(
        runWatcherLayer.pipe(Layer.provideMerge(administration))
      ),
      Layer.provide(
        Layer.succeed(ServerIdentity, {
          directory,
          instanceId,
          repositoryId: auth.repositoryId,
          shutdown: (deadline) => {
            stopAt = Math.min(stopAt, deadline);
          },
        })
      )
    );
    const serviceContext = yield* Layer.build(
      Layer.merge(services, RpcSerialization.layerJson)
    );
    yield* HostStore.use((store) => store.beginInstance(instanceId)).pipe(
      Effect.provideContext(serviceContext)
    );
    const http = yield* RpcServer.toHttpEffect(ControlPlane, {
      disableFatalDefects: true,
      streamBufferSize: 4,
    }).pipe(Effect.provideContext(serviceContext));
    const handler = rpcWebHandler(http);
    const downloadHandler = yield* contentHandler.pipe(
      Effect.provideContext(serviceContext)
    );
    const observationHandler = yield* watchHandler.pipe(
      Effect.provideContext(serviceContext)
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => {
        let inFlight = 0;
        return Bun.serve({
          fetch: async (request, bunServer) => {
            if (!authorize(request, auth.token, auth.repositoryId)) {
              return new Response("Unauthorized", { status: 401 });
            }
            if (
              request.method !== "POST" ||
              ![
                "/rpc",
                "/rpc/",
                "/rpc/content",
                "/rpc/content/",
                "/rpc/watch",
                "/rpc/watch/",
              ].includes(new URL(request.url).pathname)
            ) {
              return new Response("Not found", { status: 404 });
            }
            if (inFlight >= 32) {
              return new Response("Busy", { status: 503 });
            }
            inFlight += 1;
            try {
              if (
                ["/rpc/content", "/rpc/content/"].includes(
                  new URL(request.url).pathname
                )
              ) {
                try {
                  const bounded = await contentRequest(request);
                  // Content producers have no idle deadline; cancellation and shutdown own cleanup.
                  bunServer.timeout(request, 0);
                  return await downloadHandler(bounded);
                } catch {
                  return new Response(
                    "Invalid content RPC request (maximum 16 KiB)",
                    { status: 400 }
                  );
                }
              }
              if (
                ["/rpc/watch", "/rpc/watch/"].includes(
                  new URL(request.url).pathname
                )
              ) {
                try {
                  const bounded = await watchRequest(request);
                  bunServer.timeout(request, 0);
                  return await observationHandler(bounded);
                } catch {
                  return new Response(
                    "Invalid watch RPC request (maximum 16 KiB)",
                    { status: 400 }
                  );
                }
              }
              const body: unknown = await request.clone().json();
              checkJsonBudget(body);
              if (Array.isArray(body) && body.length > 16) {
                return new Response("RPC batch limit exceeded", {
                  status: 413,
                });
              }
              validateRpcPayloads(body);
              return await handler(request);
            } catch (error) {
              if (
                error instanceof TaskRuntimeError &&
                error.code === "LimitExceeded"
              ) {
                return new Response(
                  "RPC payload exceeds JSON boundary limits",
                  { status: 413 }
                );
              }
              return new Response("Invalid RPC request", { status: 400 });
            } finally {
              inFlight -= 1;
            }
          },
          hostname: "127.0.0.1",
          maxRequestBodySize: 1_048_576,
          port: 0,
        });
      }),
      (running) => Effect.promise(async () => await running.stop(true))
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const endpoint = {
          instanceId,
          pid: process.pid,
          url: `http://127.0.0.1:${server.port}/rpc`,
        };
        const filename = path.join(directory, "daemon.json");
        const temporary = `${filename}.tmp`;
        writeFileSync(temporary, JSON.stringify(endpoint), { mode: 0o600 });
        renameSync(temporary, filename);
        return filename;
      }),
      (filename) => Effect.sync(() => rmSync(filename, { force: true }))
    );
    while (Date.now() < stopAt) {
      yield* Effect.sleep("100 millis");
    }
    armShutdown();
  }).pipe(Effect.onInterrupt(() => Effect.sync(armShutdown)));
  return Effect.sync(() =>
    mkdirSync(directory, { mode: 0o700, recursive: true })
  ).pipe(
    Effect.andThen(
      Effect.scoped(
        program.pipe(Effect.provide(ownershipLayer(`${database}.owner`)))
      )
    ),
    Effect.ensuring(
      Effect.sync(() => {
        if (shutdownTimer !== undefined) {
          clearTimeout(shutdownTimer);
        }
      })
    )
  );
}

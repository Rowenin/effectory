/* oxlint-disable no-await-in-loop, promise/avoid-new, no-unmodified-loop-condition -- Sequential failure cases and bounded disconnection polling. */
import { expect, test } from "bun:test";

import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Telemetry from "@distilled.cloud/core/telemetry";
import { Task, Vault } from "@offtree/effectory-sdk";
import { Cause, Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { make } from "../src/contracts.ts";
import { capture } from "../src/options.ts";
import { makeBackend } from "../src/provider.ts";

const canary = "CANARY-aws-vault-private-value";
const Def = Vault.make({ id: "aws-test", secrets: { token: Schema.String } });
function fixture(timeout = 1000) {
  const inputs: unknown[] = [];
  const signed: string[] = [];
  let credentialReads = 0;
  let interrupted = 0;
  let response: unknown = { SecretString: canary };
  let status = 200;
  let mode: "response" | "slow" | "defect" = "response";
  const credentials = Layer.succeed(
    Credentials.Credentials,
    Effect.sync(() => {
      credentialReads += 1;
      return {
        accessKeyId: Redacted.make("SYNTHETIC"),
        region: "us-west-2" as const,
        secretAccessKey: Redacted.make("SYNTHETIC"),
        sessionToken: undefined,
      };
    })
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      inputs.push(
        JSON.parse(
          new TextDecoder().decode(
            request.body._tag === "Uint8Array"
              ? request.body.body
              : new Uint8Array()
          )
        )
      );
      signed.push(request.headers.authorization ?? "");
      if (mode === "slow") {
        return Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted += 1;
            })
          )
        );
      }
      if (mode === "defect") {
        return Effect.die(new Error(canary));
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(response, {
            headers: { "content-type": "application/x-amz-json-1.1" },
            status,
          })
        )
      );
    })
  );
  const implementation: Vault.Implementation = (spec) =>
    makeBackend(
      spec,
      capture({
        region: "eu-west-1",
        requestTimeout: timeout,
        secrets: {
          token: {
            secretId: "private-locator",
            versionId: "v1",
            versionStage: "AWSPREVIOUS",
          },
        },
      }),
      Layer.mergeAll(credentials, http)
    );
  return {
    implementation,
    inputs,
    layer: Vault.layer(Def, implementation),
    mode: (next: typeof mode) => {
      mode = next;
    },
    respond: (body: unknown, code = 200) => {
      response = body;
      status = code;
    },
    signed,
    stats: () => ({ credentialReads, interrupted }),
  };
}
function errorText(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true);
  return Exit.isFailure(exit)
    ? Cause.pretty(exit.cause) + JSON.stringify(exit.cause)
    : "";
}

test("options are strict, immutable and do not expose submitted values", () => {
  const original = {
    region: "us-east-1",
    secrets: { token: { secretId: "first" } },
  };
  const captured = capture(original);
  original.secrets.token.secretId = "second";
  expect(captured.secrets.token?.secretId).toBe("first");
  expect(captured.timeoutMillis).toBe(30_000);
  expect(Object.isFrozen(captured.secrets.token)).toBe(true);
  for (const invalid of [
    { region: "", secrets: {} },
    { extra: canary, region: "x", secrets: {} },
    { region: "x", secrets: { "-bad": canary } },
    ...[undefined, null, 0, -1, Infinity, "Infinity", "1 month", 300_001].map(
      (requestTimeout) => ({ region: "x", requestTimeout, secrets: {} })
    ),
    {
      region: "x",
      secrets: { token: { secretId: canary, versionId: undefined } },
    },
  ]) {
    // Runtime callers are untyped, so bypass the static options parameter.
    expect(() => {
      Reflect.apply(make, undefined, [invalid]);
    }).toThrow("Invalid AWS vault options");
    try {
      Reflect.apply(make, undefined, [invalid]);
    } catch (error) {
      expect(String(error)).not.toContain(canary);
    }
  }
});

test("mapping validation and acquisition perform no authentication or requests", async () => {
  const f = fixture();
  await Effect.runPromise(Effect.scoped(Layer.build(f.layer)));
  expect(f.stats().credentialReads).toBe(0);
  expect(f.inputs).toHaveLength(0);
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Layer.build(Vault.layer(Def, make({ region: "us-east-1", secrets: {} })))
    )
  );
  expect(errorText(exit)).toContain("mappings must match");
});

test("real Distilled requests preserve selectors, explicit region and fresh raw values", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(f.layer);
        const first = yield* Def.get("token").pipe(
          Effect.provideContext(context)
        );
        expect(Redacted.value(first)).toBe(canary);
        f.respond({ SecretString: "\n" });
        expect(
          Redacted.value(
            yield* Def.get("token").pipe(Effect.provideContext(context))
          )
        ).toBe("\n");
        f.respond({ SecretString: "" });
        expect(
          Redacted.value(
            yield* Def.get("token").pipe(Effect.provideContext(context))
          )
        ).toBe("");
      })
    )
  );
  expect(f.inputs).toEqual(
    Array.from({ length: 3 }, () => ({
      SecretId: "private-locator",
      VersionId: "v1",
      VersionStage: "AWSPREVIOUS",
    }))
  );
  expect(
    f.signed.every((header) =>
      header.includes("/eu-west-1/secretsmanager/aws4_request")
    )
  ).toBe(true);
});

test("missing is None; errors are sanitized, mapped and never retried by the adapter", async () => {
  const f = fixture();
  f.respond({ Message: canary, __type: "ResourceNotFoundException" }, 400);
  expect(
    Option.isNone(
      await Effect.runPromise(
        Def.getOption("token").pipe(Effect.provide(f.layer))
      )
    )
  ).toBe(true);
  for (const [tag, reason] of [
    ["AccessDeniedException", "Unauthorized"],
    ["InvalidParameterException", "InvalidDefinition"],
    ["InvalidRequestException", "InvalidDefinition"],
    ["DecryptionFailure", "Corrupt"],
    ["InternalServiceError", "Unreachable"],
    ["ThrottlingException", "Unreachable"],
  ] as const) {
    const before = f.inputs.length;
    f.respond({ Message: canary, __type: tag }, 400);
    const text = errorText(
      await Effect.runPromiseExit(
        Def.get("token").pipe(Effect.provide(f.layer))
      )
    );
    expect(text).toContain(reason);
    expect(text).not.toContain(canary);
    expect(text).not.toContain("private-locator");
    expect(f.inputs.length).toBe(before + 1);
  }
});

test("binary, malformed and oversized replies fail without exposing content", async () => {
  const f = fixture();
  for (const [body, reason] of [
    [{ SecretBinary: btoa(canary) }, "Unsupported"],
    [{}, "Corrupt"],
    [{ SecretString: "é".repeat(32_769) }, "LimitExceeded"],
  ] as const) {
    f.respond(body);
    const text = errorText(
      await Effect.runPromiseExit(
        Def.get("token").pipe(Effect.provide(f.layer))
      )
    );
    expect(text).toContain(reason);
    expect(text).not.toContain(canary);
  }
  f.respond({ SecretString: "é".repeat(32_768) });
  expect(
    Redacted.value(
      await Effect.runPromise(Def.get("token").pipe(Effect.provide(f.layer)))
    ).length
  ).toBe(32_768);
});

test("timeouts interrupt requests and direct backend defects cannot leak through debug", async () => {
  const f = fixture(30);
  f.mode("slow");
  expect(
    errorText(
      await Effect.runPromiseExit(
        Def.get("token").pipe(Effect.provide(f.layer))
      )
    )
  ).toContain("Unreachable");
  expect(f.stats().interrupted).toBe(1);
  f.mode("defect");
  let debug = 0;
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* f.implementation({
          id: Def.id,
          keys: ["token"],
        });
        return yield* backend.read("token");
      })
    ).pipe(
      Effect.provideService(Telemetry.Debug, {
        attempt: (effect) => {
          debug += 1;
          return effect;
        },
        callSite: () => ({}),
        logRequests: true,
        phase: (_name, effect) => {
          debug += 1;
          return effect;
        },
        readStream: (stream) => stream,
      })
    )
  );
  expect(errorText(exit)).not.toContain(canary);
  expect(debug).toBe(0);
});

test("Task.test uses existing secret protection and ordinary memory substitution", async () => {
  const f = fixture();
  const task = Task.make(
    {
      error: Vault.Errors,
      id: "aws/read",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.String,
      version: 1,
    },
    () => Effect.map(Def.get("token"), Redacted.value)
  );
  const text = errorText(
    await Effect.runPromiseExit(
      Task.test(task.provide(f.layer), { input: null })
    )
  );
  expect(text).toContain("SecretInOutput");
  expect(text).not.toContain(canary);
  const check = Task.make(
    {
      error: Vault.Errors,
      id: "aws/check",
      input: Schema.Null,
      replay: "idempotent",
      success: Schema.Boolean,
      version: 1,
    },
    () => Effect.as(Def.get("token"), true)
  );
  const before = f.inputs.length;
  await Effect.runPromise(
    Task.test(
      check.provide(Vault.layer(Def, Vault.memory({ token: "test-value" }))),
      { input: null }
    )
  );
  expect(f.inputs.length).toBe(before);
});

test("timeout aborts a real HTTP request through Distilled and FetchHttpClient", async () => {
  let requests = 0;
  let disconnected = 0;
  const server = Bun.serve({
    fetch: async (request) => {
      requests += 1;
      request.signal.addEventListener("abort", () => {
        disconnected += 1;
      });
      return await new Promise<Response>(() => {});
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const http = Layer.effect(
      HttpClient.HttpClient,
      Effect.map(
        HttpClient.HttpClient,
        HttpClient.mapRequest((request) =>
          HttpClientRequest.setUrl(request, `http://127.0.0.1:${server.port}/`)
        )
      )
    ).pipe(Layer.provide(FetchHttpClient.layer));
    const credentials = Credentials.fromCredentials(
      {
        accessKeyId: Redacted.make("SYNTHETIC"),
        secretAccessKey: Redacted.make("SYNTHETIC"),
      },
      "us-east-1"
    );
    const layer = Vault.layer(Def, (spec) =>
      makeBackend(
        spec,
        capture({
          region: "us-east-1",
          requestTimeout: 200,
          secrets: { token: "pending" },
        }),
        Layer.mergeAll(credentials, http)
      )
    );
    expect(
      errorText(
        await Effect.runPromiseExit(
          Def.get("token").pipe(Effect.provide(layer))
        )
      )
    ).toContain("Unreachable");
    for (let count = 0; count < 50 && disconnected === 0; count += 1) {
      await Bun.sleep(20);
    }
    expect(disconnected).toBe(1);
    expect(requests).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("independent vault Layers do not cross providers or identities", async () => {
  const f = fixture();
  const Other = Vault.make({ id: "other", secrets: { token: Schema.String } });
  const values = await Effect.runPromise(
    Effect.all([Def.get("token"), Other.get("token")]).pipe(
      Effect.provide(
        Layer.mergeAll(
          f.layer,
          Vault.layer(Other, Vault.memory({ token: "memory-value" }))
        )
      )
    )
  );
  expect(values.map(Redacted.value)).toEqual([canary, "memory-value"]);
  expect(f.inputs).toHaveLength(1);
});

test("Distilled credential discovery failures use KeyMissing and discard their nested cause", async () => {
  const credentials = Layer.succeed(
    Credentials.Credentials,
    Effect.fail(
      new Credentials.AwsCredentialProviderError({
        cause: new Error(canary),
        message: canary,
        provider: "chain",
      })
    )
  );
  let requests = 0;
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => {
      requests += 1;
      return Effect.die("unreachable");
    })
  );
  const layer = Vault.layer(Def, (spec) =>
    makeBackend(
      spec,
      capture({ region: "us-east-1", secrets: { token: "never-sent" } }),
      Layer.mergeAll(credentials, http)
    )
  );
  const text = errorText(
    await Effect.runPromiseExit(Def.get("token").pipe(Effect.provide(layer)))
  );
  expect(text).toContain("KeyMissing");
  expect(text).not.toContain(canary);
  expect(requests).toBe(0);
});

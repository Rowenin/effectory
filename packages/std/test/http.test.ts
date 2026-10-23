import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import * as Http from "../src/http.ts";

let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    fetch: (request) =>
      new URL(request.url).pathname === "/ok"
        ? new Response("ok")
        : new Response("down", { status: 503 }),
    hostname: "127.0.0.1",
    port: 0,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("Http probes", () => {
  test("are schema data", () => {
    const probes = [
      Http.ok("http://localhost:1/health", { intervalMs: 5, timeoutMs: 50 }),
      Http.Ready.port(3000, { host: "localhost" }),
      Http.Ready.delay(10),
    ];
    const encoded = probes.map((probe) =>
      Schema.encodeUnknownSync(Http.Probe)(probe)
    );
    expect(structuredClone(encoded)).toEqual(probes);
    expect(
      encoded.map((probe) => Schema.decodeSync(Http.Probe)(probe))
    ).toEqual(probes);
    expect(() =>
      Schema.decodeSync(Http.Probe)({ _tag: "port", port: -1 })
    ).toThrow();
  });

  test("check: 2xx is ready, anything else or no server is not", async () => {
    expect(await run(Http.check(Http.ok(`${base}/ok`)))).toBe(true);
    expect(await run(Http.check(Http.ok(`${base}/down`)))).toBe(false);
    expect(await run(Http.check(Http.port(server.port ?? 0)))).toBe(true);
    const closed = Bun.serve({ fetch: () => new Response(), port: 0 });
    const closedPort = closed.port ?? 0;
    await closed.stop(true);
    expect(
      await run(Http.check(Http.ok(`http://127.0.0.1:${closedPort}/`)))
    ).toBe(false);
    expect(await run(Http.check(Http.port(closedPort)))).toBe(false);
  });

  test("wait polls until ready, or fails with NotReady at the deadline", async () => {
    await run(Http.wait(Http.ok(`${base}/ok`)));
    const error = await run(
      Http.wait(
        Http.ok(`${base}/down`, { intervalMs: 10, timeoutMs: 100 })
      ).pipe(Effect.flip)
    );
    expect(error._tag).toBe("NotReady");
    expect(error.message).toBe(`${base}/down was not ready after 100ms`);
    const started = Date.now();
    await run(Http.wait(Http.delay(50)));
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  test("wait stops early when abort fails", async () => {
    const error = await run(
      Http.wait(Http.ok(`${base}/down`, { intervalMs: 10 }), {
        abort: Effect.fail(
          new Http.NotReady({ message: "exited", probe: Http.delay(0) })
        ),
      }).pipe(Effect.flip)
    );
    expect(error.message).toBe("exited");
  });
});

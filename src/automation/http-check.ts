import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schema from "effect/Schema";

const HttpUrl = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const url = URL.parse(value);
      return (
        url !== null && (url.protocol === "http:" || url.protocol === "https:")
      );
    },
    { expected: "an absolute HTTP or HTTPS URL", jsonSchema: { format: "uri" } }
  )
);

export const HttpCheckConfig = Schema.Struct({
  timeoutMs: Schema.Int.check(
    Schema.isBetween({ maximum: 60_000, minimum: 1 })
  ).annotate({
    description: "Time limit in milliseconds (1–60000)",
  }),
  url: HttpUrl.annotate({ description: "The endpoint to check" }),
});

export const HttpCheckResult = Schema.Struct({
  failure: Schema.NullOr(Schema.Literals(["timeout", "transport"])),
  latencyMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  ok: Schema.Boolean,
  status: Schema.Int.check(Schema.isBetween({ maximum: 599, minimum: 0 })),
});

export const httpCheckDescription = {
  config: Schema.toJsonSchemaDocument(HttpCheckConfig),
  description:
    "Observe an HTTP endpoint. An unhealthy response is recorded as data.",
  methods: {
    check: {
      input: Schema.toJsonSchemaDocument(Schema.Struct({})),
      output: Schema.toJsonSchemaDocument(HttpCheckResult),
    },
  },
  type: "http/check",
  version: 1,
};

export const checkHttp = Effect.fn("HttpCheck.check")(function* checkHttp(
  input: unknown
) {
  const config = yield* Schema.decodeUnknownEffect(HttpCheckConfig)(input);
  const client = yield* HttpClient.HttpClient;
  const start = yield* Clock.currentTimeNanos;
  const observation = yield* HttpClient.withScope(client)
    .get(config.url)
    .pipe(
      Effect.map((response) => ({
        failure: null,
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
      })),
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: config.timeoutMs,
        orElse: () =>
          Effect.succeed({ failure: "timeout" as const, ok: false, status: 0 }),
      }),
      Effect.catchTag("HttpClientError", () =>
        Effect.succeed({ failure: "transport" as const, ok: false, status: 0 })
      )
    );
  const end = yield* Clock.currentTimeNanos;
  return yield* Schema.decodeEffect(HttpCheckResult)({
    ...observation,
    latencyMs: Number(end - start) / 1_000_000,
  });
});

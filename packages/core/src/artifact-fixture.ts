import { Effect, Schema } from "effect";

import type * as Artifact from "./artifact.ts";
import {
  canonical,
  encode,
  identifier,
  version,
  checkJsonBudget,
  jsonLimits,
} from "./boundary.ts";
import { TaskRuntimeError } from "./errors.ts";

const brand: unique symbol = Symbol("ArtifactFixture");
export interface Fixture<A extends Artifact.Any = Artifact.Any> {
  readonly [brand]: true;
  readonly reference: A["refSchema"]["Type"];
}
export interface FixtureOptions {
  readonly taskId?: string;
  readonly output?: string;
  readonly key?: string;
  readonly version?: number;
  readonly tags?: Readonly<Record<string, string>>;
  readonly committedAt?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly invocationPath?: string;
  readonly revision?: string;
}
export interface FixtureData {
  readonly artifact: Artifact.Any;
  readonly options: FixtureOptions & {
    readonly taskId: string;
    readonly output: string;
    readonly key: string;
  };
  readonly reference: Artifact.Reference;
  readonly content: string | Uint8Array;
  readonly digest: string;
}
const data = new WeakMap<object, FixtureData>();
export const fixtureData = (value: Fixture) => data.get(value);
export const invalidFixture = (message = "Invalid artifact fixture") =>
  new TaskRuntimeError({ code: "InvalidBoundary", message });
export const digestContent = (bytes: Uint8Array) =>
  Effect.promise(async () => {
    const result = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    return [...new Uint8Array(result)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  });
export function captureFixture(value: FixtureData): Fixture {
  const reference = Object.freeze({ ...value.reference });
  const result: Fixture = Object.freeze({ [brand]: true as const, reference });
  data.set(result, {
    ...value,
    content:
      typeof value.content === "string"
        ? value.content
        : new Uint8Array(value.content),
    options: Object.freeze({
      ...value.options,
      tags: Object.freeze({ ...value.options.tags }),
    }),
    reference,
  });
  return result;
}
export function fixture<A extends Artifact.Any>(
  artifact: A,
  value: NoInfer<
    A extends Artifact.Artifact ? A["schema"]["Type"] : Uint8Array
  >,
  options: FixtureOptions = {}
): Effect.Effect<Fixture<A>, TaskRuntimeError> {
  return Effect.gen(function* () {
    const prepared = yield* Effect.try({
      catch: () => invalidFixture(),
      try: () => {
        const taskId = identifier(options.taskId ?? "fixture");
        const output = identifier(options.output ?? "value");
        const key = identifier(options.key ?? artifact.id);
        version(options.version ?? 1);
        for (const name of Object.keys(options)) {
          if (
            ![
              "taskId",
              "output",
              "key",
              "version",
              "tags",
              "committedAt",
              "runId",
              "attemptId",
              "invocationPath",
              "revision",
            ].includes(name)
          ) {
            throw invalidFixture();
          }
        }
        if (
          options.committedAt !== undefined &&
          new Date(options.committedAt).toISOString() !== options.committedAt
        ) {
          throw invalidFixture();
        }
        const tags = Schema.decodeUnknownSync(
          Schema.Record(Schema.String, Schema.String)
        )(options.tags ?? {});
        if (new TextEncoder().encode(canonical(tags)).length > 8192) {
          throw invalidFixture();
        }
        let content: string | Uint8Array;
        if (artifact.kind === "bytes") {
          if (!(value instanceof Uint8Array) || value.byteLength > 16_777_216) {
            throw invalidFixture();
          }
          content = new Uint8Array(value);
        } else {
          const encoded = encode(artifact.schema, value);
          checkJsonBudget(encoded, jsonLimits);
          content = canonical(encoded);
          if (new TextEncoder().encode(content).length > 1_048_576) {
            throw invalidFixture();
          }
        }
        return { content, options: { ...options, key, output, tags, taskId } };
      },
    });
    const bytes =
      typeof prepared.content === "string"
        ? new TextEncoder().encode(prepared.content)
        : prepared.content;
    const digest = yield* digestContent(bytes);
    const artifactId = yield* digestContent(
      new TextEncoder().encode(
        canonical([
          "test-owner",
          prepared.options.taskId,
          prepared.options.output,
          prepared.options.key,
        ])
      )
    );
    return captureFixture({
      artifact,
      ...prepared,
      digest,
      reference: {
        artifactId,
        digest,
        schemaId: artifact.id,
        schemaVersion: artifact.version,
        version: options.version ?? 1,
      },
    }) as Fixture<A>;
  });
}

/* oxlint-disable unicorn/no-await-expression-member, max-classes-per-file -- Assertions inspect fixture results; distinct services prove requirement inference. */
import { expect, test } from "bun:test";

import { Context, Effect, Layer, Option, Schema, SchemaGetter } from "effect";

import { Application, Artifact } from "../src/index.ts";
import { declarations, normalize, validate } from "../src/tag-state.ts";
import * as Tag from "../src/tag.ts";
import * as Task from "../src/task.ts";

const Team = Tag.make("team", Schema.NonEmptyString);
const Build = Tag.make("build", Schema.Int);
const spec = {
  error: Schema.Never,
  id: "metadata",
  input: Schema.Null,
  replay: "idempotent" as const,
  success: Schema.String,
  version: 1,
};

test("typed bindings and optional declarations preserve exact labels", () => {
  expect(normalize([Team("platform"), Build(42)])).toEqual({
    build: "42",
    team: "platform",
  });
  const root = declarations([Team("platform"), Build]);
  expect(() => validate(root.tags, root.tagSchemas)).not.toThrow();
  expect(() => validate({ build: "bad" }, root.tagSchemas)).toThrow("build");
  expect(() => normalize([Team])).toThrow("canonical");
  expect(() => declarations([Build, Build(2)])).toThrow("Duplicate");
  expect(() => normalize(new Date())).toThrow();
  const Nullable = Tag.make("nullable", Schema.NullOr(Schema.String));
  expect(() => Nullable("null")).toThrow("round-trip");
});

test("value reads use ordinary DI and preserve absence versus invalid metadata", async () => {
  const result = await Effect.runPromise(
    Effect.all({ build: Build.value(), team: Team.value() }).pipe(
      Effect.provideService(Tag.Values, { build: "042" })
    )
  );
  expect(result).toEqual({ build: Option.some(42), team: Option.none() });
  const error = await Effect.runPromise(
    Build.value().pipe(
      Effect.provideService(Tag.Values, { build: "bad" }),
      Effect.flip
    )
  );
  expect(error.code).toBe("InvalidBoundary");
  expect(error.message).toContain("build");
});

test("Task.test supplies invocation tags over caller context and keeps copies isolated", async () => {
  const task = Task.make(spec, (_, context) =>
    Effect.gen(function* () {
      const values = yield* Tag.Values;
      expect(values).toBe(context.tags);
      expect(Object.isFrozen(values)).toBe(true);
      yield* Effect.yieldNow;
      return Option.getOrElse(yield* Team.value(), () => "none");
    })
  );
  const values = await Effect.runPromise(
    Effect.all(
      [
        Task.test(task, { input: null, tags: [Team("one")] }),
        Task.test(task, { input: null, tags: [Team("two")] }),
        Task.test(task, { input: null }),
      ],
      { concurrency: "unbounded" }
    ).pipe(Effect.provideService(Tag.Values, { team: "outside" }))
  );
  expect(values.map((value) => value.value)).toEqual(["one", "two", "none"]);
});

class Owner extends Context.Service<Owner, string>()("tag-test/Owner") {}
test("task-local Layers can read tags and retain typed read failures", async () => {
  const layer = Layer.effect(
    Owner,
    Team.value().pipe(Effect.map(Option.getOrElse(() => "none")))
  );
  const task = Task.make(spec, () => Owner).provide(layer);
  expect(
    (
      await Effect.runPromise(
        Task.test(task, { input: null, tags: [Team("platform")] })
      )
    ).value
  ).toBe("platform");
  const error = await Effect.runPromise(
    Task.test(task, { input: null, tags: { team: "" } }).pipe(Effect.flip)
  );
  expect(error.code).toBe("InvalidBoundary");
  expect(error.message).toContain("team");
});

test("task Layers acquire and release per invocation even under a shared revision memo map", async () => {
  const acquired: string[] = [];
  const released: string[] = [];
  const layer = Layer.effect(
    Owner,
    Effect.acquireRelease(
      Team.value().pipe(
        Effect.map((team) => {
          const value = Option.getOrElse(team, () => "none");
          acquired.push(value);
          return value;
        })
      ),
      () =>
        Team.value().pipe(
          Effect.orDie,
          Effect.map((team) =>
            released.push(Option.getOrElse(team, () => "none"))
          )
        )
    )
  );
  const task = Task.make(spec, () => Owner).provide(layer);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer);
        expect(yield* Owner.pipe(Effect.provideContext(context))).toBe(
          "application"
        );
        const values = yield* Effect.all(
          [
            Task.test(task, { input: null, tags: [Team("one")] }),
            Task.test(task, { input: null, tags: [Team("two")] }),
          ],
          { concurrency: "unbounded" }
        ).pipe(Effect.provideContext(context));
        expect(values.map((value) => value.value)).toEqual(["one", "two"]);
        expect(released.toSorted()).toEqual(["one", "two"]);
      })
    ).pipe(Effect.provideService(Tag.Values, { team: "application" }))
  );
  expect(acquired.toSorted()).toEqual(["application", "one", "two"]);
  expect(released.toSorted()).toEqual(["application", "one", "two"]);
});

test("explicit task-local DI overrides reads without rewriting the admitted raw map", async () => {
  const task = Task.make(spec, (_, context) =>
    Effect.gen(function* () {
      expect(context.tags.team).toBe("admitted");
      return Option.getOrElse(yield* Team.value(), () => "none");
    })
  ).provide(Layer.succeed(Tag.Values, { team: "local" }));
  const result = await Effect.runPromise(
    Task.test(task, { input: null, tags: [Team("admitted")] })
  );
  expect(result.value).toBe("local");
});

class Other extends Context.Service<Other, string>()("tag-test/Other") {}
export const tagRequirementProof = () => {
  const layer = Layer.effect(
    Owner,
    Effect.gen(function* () {
      yield* Team.value();
      return yield* Other;
    })
  );
  const task = Task.make(spec, () => Owner).provide(layer);
  const missing = Application.make({ tasks: [task] });
  // @ts-expect-error Other is still a real application requirement.
  const invalid: Application.Application<never> = missing;
  const valid: Application.Application<never> = missing.provide(
    Layer.succeed(Other, "ok")
  );
  const implementation = Task.implementation(
    { id: "metadata-implementation", target: task },
    () => Team.value().pipe(Effect.map(Option.getOrElse(() => "none")))
  );
  const complete: Application.Application<never> = Application.make({
    tasks: [implementation],
  });
  // @ts-expect-error Typed bindings reject string values for an integer tag.
  Build("42");
  return { complete, invalid, valid };
};

test("publications merge raw run labels and typed overrides with the wider publication budget", async () => {
  const artifact = Artifact.make({
    id: "tagged-text",
    schema: Schema.String,
    version: 1,
  });
  const task = Task.make(
    { ...spec, outputs: { report: artifact } },
    (_, context) =>
      Effect.gen(function* () {
        yield* context.publish("report", "one", {
          key: "one",
          tags: [Team("explicit")],
        });
        yield* context.publish("report", "two", { key: "two", tags: {} });
        yield* context.publish("report", "three", {
          key: "three",
          tags: { kind: "report", ...context.tags },
        });
        return "ok";
      })
  );
  const tags = Object.fromEntries(
    Array.from({ length: 15 }, (_, index) => [`label${index}`, "x".repeat(256)])
  );
  const result = await Effect.runPromise(
    Task.test(task, { input: null, tags: { ...tags, team: "inherited" } })
  );
  expect(
    result.publications.map((publication) => publication.tags.team)
  ).toEqual(["explicit", "inherited", "inherited"]);
  expect(result.publications[2]?.tags.kind).toBe("report");
  const oversized = Task.make(
    { ...spec, outputs: { report: artifact } },
    (_, context) =>
      Effect.gen(function* () {
        yield* context.publish("report", "one", {
          key: "one",
          tags: { large: "x".repeat(8200) },
        });
        return "ok";
      })
  );
  const failure = await Effect.runPromise(
    Task.test(oversized, { input: null }).pipe(Effect.flip)
  );
  expect(failure.code).toBe("LimitExceeded");
});

test("async codecs get explicit synchronous-boundary errors but remain ordinary Effects at read time", async () => {
  const codec = Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transformEffect((value) =>
        Effect.succeed(value).pipe(Effect.delay("1 millis"))
      ),
      encode: SchemaGetter.transformEffect((value) =>
        Effect.succeed(value).pipe(Effect.delay("1 millis"))
      ),
    })
  );
  const Async = Tag.make("async", codec);
  expect(() => Async("hello")).toThrow("synchronously");
  const declared = declarations([Async]);
  expect(() => validate({ async: "hello" }, declared.tagSchemas)).toThrow(
    "synchronously"
  );
  expect(
    await Effect.runPromise(
      Async.value().pipe(Effect.provideService(Tag.Values, { async: "hello" }))
    )
  ).toEqual(Option.some("hello"));
  const Nullable = Tag.make("nullable", Schema.NullOr(Schema.String));
  expect(
    await Effect.runPromise(
      Nullable.value().pipe(
        Effect.provideService(Tag.Values, { nullable: "null" })
      )
    )
  ).toEqual(Option.some(null));
});

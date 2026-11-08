import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Tag } from "@offtree/effectory-sdk";
import { Effect, Exit, Fiber, Layer, Scope } from "effect";

import { Catalog } from "../src/catalog.ts";
import { ownershipLayer } from "../src/ownership.ts";
import { revisionCatalogLayer } from "../src/revisions.ts";
import { vaultHandlers } from "../src/vault-control.ts";

const application = (label: string, marker: string) => `
import { appendFileSync } from "node:fs";
import { Application, Tag } from "@offtree/effectory-sdk";
import { Context, Effect, Layer, Option } from "effect";
const Resource = Context.Service("test/RevisionBorrowers");
const record = (phase) => Effect.sync(() => appendFileSync(${JSON.stringify(marker)}, phase + ":" + ${JSON.stringify(label)} + "\\n"));
const acquire = Effect.gen(function* () {
 const tags = yield* Effect.serviceOption(Tag.Values);
 yield* record(Option.isSome(tags) ? "LEAK" : "acquire");
});
const resource = Layer.effect(Resource, Effect.acquireRelease(acquire, () => record("release")));
export default Application.make({}).provide(resource);
`;
interface Fixture {
  readonly filename: string;
  readonly marker: string;
  readonly records: Effect.Effect<string[]>;
  readonly change: (label: string) => Effect.Effect<void>;
}
async function withCatalog<E>(
  body: (fixture: Fixture) => Effect.Effect<void, E, Catalog | Scope.Scope>
) {
  const repository = await mkdtemp(path.join(tmpdir(), "effectory-borrowers-"));
  const state = path.join(repository, ".effectory");
  const marker = path.join(repository, "resources.txt");
  const filename = path.join(repository, "effectory.ts");
  try {
    await mkdir(state);
    await writeFile(filename, application("first", marker));
    await Effect.runPromise(
      body({
        change: (label) =>
          Effect.promise(
            async () => await writeFile(filename, application(label, marker))
          ),
        filename,
        marker,
        records: Effect.promise(
          async () => await readFile(marker, "utf-8")
        ).pipe(Effect.map((text) => text.trim().split("\n"))),
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.scoped,
        Effect.provide(
          revisionCatalogLayer(repository).pipe(
            Layer.provide(ownershipLayer(path.join(state, "owner")))
          )
        )
      )
    );
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
}
const switchTo = (catalog: typeof Catalog.Service) =>
  Effect.gen(function* () {
    yield* catalog.activate(yield* catalog.prepare());
  }).pipe(Effect.scoped);

test("concurrent revision borrowers survive activation; last release unloads and later access reacquires", async () =>
  await withCatalog(({ change, records }) =>
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      const old = catalog.active;
      const a = yield* Scope.make();
      const b = yield* Scope.make();
      const [first, second] = yield* Effect.all(
        [
          catalog.get(old).pipe(Effect.provideService(Scope.Scope, a)),
          catalog.get(old).pipe(Effect.provideService(Scope.Scope, b)),
        ],
        { concurrency: "unbounded" }
      );
      expect(first.registry).toBe(second.registry);
      yield* change("second");
      yield* switchTo(catalog);
      expect(yield* records).toEqual(["acquire:first", "acquire:second"]);
      yield* Scope.close(a, Exit.void);
      expect(yield* records).toEqual(["acquire:first", "acquire:second"]);
      yield* Scope.close(b, Exit.void);
      expect(yield* records).toEqual([
        "acquire:first",
        "acquire:second",
        "release:first",
      ]);
      catalog.assertExecutable(old);
      expect(() => catalog.assertExecutable("missing")).toThrow("unavailable");
      // Metadata checks do not reacquire an inactive application Layer.
      expect(yield* records).toEqual([
        "acquire:first",
        "acquire:second",
        "release:first",
      ]);
      const later = yield* catalog.get(old).pipe(
        Effect.scoped,
        Effect.provideService(Tag.Values, {
          secret: "must-not-enter-application-context",
        })
      );
      expect(later.registry).not.toBe(first.registry);
      expect(yield* records).toEqual([
        "acquire:first",
        "acquire:second",
        "release:first",
        "acquire:first",
        "release:first",
      ]);
    })
  ));

test("a candidate cannot activate after its owner closes and failed publication releases its temporary pin", async () =>
  await withCatalog(({ change, records }) =>
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      const { active } = catalog;
      yield* change("second");
      const expired = yield* catalog.prepare().pipe(Effect.scoped);
      expect((yield* Effect.result(catalog.activate(expired)))._tag).toBe(
        "Failure"
      );
      expect(yield* records).toEqual([
        "acquire:first",
        "acquire:second",
        "release:second",
      ]);
      yield* Effect.gen(function* () {
        const candidate = yield* catalog.prepare();
        expect(
          (yield* Effect.result(
            catalog.activate(candidate, () => {
              throw new Error("synthetic publication failure");
            })
          ))._tag
        ).toBe("Failure");
        expect(catalog.active).toBe(active);
      }).pipe(Effect.scoped);
      expect(yield* records).toEqual([
        "acquire:first",
        "acquire:second",
        "release:second",
        "acquire:second",
        "release:second",
      ]);
    })
  ));

test("failed application acquisition closes its resource and can be retried", async () =>
  await withCatalog(({ filename, marker, records }) =>
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      const broken = application("broken", marker).replace(
        'Effect.acquireRelease(acquire, () => record("release"))',
        'Effect.acquireRelease(acquire, () => record("release")).pipe(Effect.andThen(Effect.fail("synthetic failure")))'
      );
      yield* Effect.promise(async () => await writeFile(filename, broken));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(
          (yield* Effect.result(catalog.prepare().pipe(Effect.scoped)))._tag
        ).toBe("Failure");
      }
      expect(yield* records).toEqual([
        "acquire:first",
        "acquire:broken",
        "release:broken",
        "acquire:broken",
        "release:broken",
      ]);
    })
  ));

test.each(["finish", "interrupt"] as const)(
  "historical vault reads retain the provider through %s",
  async (mode) =>
    await withCatalog(({ filename, marker, change, records }) =>
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        const gate = `${marker}.gate`;
        yield* Effect.promise(
          async () =>
            await writeFile(
              filename,
              `
import { appendFileSync, existsSync } from "node:fs";
import { Application, Vault } from "@offtree/effectory-sdk";
import { Effect, Option, Redacted, Schema } from "effect";
const record = (phase) => Effect.sync(() => appendFileSync(${JSON.stringify(marker)}, phase + ":vault\\n"));
const credentials = Vault.make({ id: "credentials", secrets: { token: Schema.String } });
const provider = Vault.layer(credentials, () => Effect.acquireRelease(
 record("acquire").pipe(Effect.as({ providerId: "test/vault", read: () => Effect.gen(function* () {
   yield* record("reading");
   while (!existsSync(${JSON.stringify(gate)})) yield* Effect.sleep("5 millis");
   return Option.some(Redacted.make("synthetic-token"));
 }).pipe(Effect.ensuring(record("read-closed"))) })),
 () => record("release")
));
export default Application.make({ vaults: [credentials] }).provide(provider);
`
            )
        );
        yield* switchTo(catalog);
        const revision = catalog.active;
        yield* change("last");
        yield* switchTo(catalog);
        const before = (yield* records).length;
        const read = yield* vaultHandlers(catalog)
          .VaultReveal({ key: "token", revision, vault: "credentials" })
          .pipe(Effect.forkScoped);
        while (!(yield* records).slice(before).includes("reading:vault")) {
          yield* Effect.sleep("5 millis");
        }
        expect((yield* records).slice(before)).toEqual([
          "acquire:vault",
          "reading:vault",
        ]);
        if (mode === "finish") {
          yield* Effect.promise(async () => await writeFile(gate, "continue"));
          expect((yield* Fiber.join(read)).value).toBe("synthetic-token");
        } else {
          yield* Fiber.interrupt(read);
        }
        expect((yield* records).slice(before)).toEqual([
          "acquire:vault",
          "reading:vault",
          "read-closed:vault",
          "release:vault",
        ]);
      })
    )
);

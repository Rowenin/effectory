import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Tag } from "@offtree/effectory-sdk";
import {
  declarations,
  normalize,
} from "@offtree/effectory-sdk/internal/tag-state";
import { Effect, Option, Schema } from "effect";

import { installHostModules } from "../src/host-runtime.ts";
import { importModule } from "./fixtures/import-module.ts";

test("external application and extension modules share bindings while foreign copies only share the DI service key", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-tag-modules-")
  );
  try {
    installHostModules();
    const application = path.join(directory, "application.mjs");
    const extension = path.join(directory, "extension.mjs");
    await writeFile(
      application,
      'import { Tag } from "@offtree/effectory-sdk"; import { Schema } from "effect"; export const Team = Tag.make("team", Schema.String);'
    );
    await writeFile(
      extension,
      'import * as Tag from "@offtree/effectory-sdk/Tag"; import * as Schema from "effect/Schema"; export const Build = Tag.make("build", Schema.Int);'
    );
    const app = await importModule<{
      Team: Tag.Definition<"team", typeof Schema.String>;
    }>(application, { Team: "function" });
    const ext = await importModule<{
      Build: Tag.Definition<"build", typeof Schema.Int>;
    }>(extension, { Build: "function" });
    expect(normalize([app.Team("platform"), ext.Build(42)])).toEqual({
      build: "42",
      team: "platform",
    });
    expect(Object.keys(declarations([app.Team, ext.Build]).tagSchemas)).toEqual(
      ["team", "build"]
    );
    const foreign = path.join(directory, "foreign.mjs");
    const built = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "../../core/src/tag.ts")],
      external: ["effect", "effect/*"],
      format: "esm",
      target: "bun",
    });
    expect(built.success).toBe(true);
    const [output] = built.outputs;
    if (!output) {
      throw new Error("Missing duplicate SDK bundle");
    }
    await writeFile(foreign, await output.text());
    const duplicate = await importModule<Pick<typeof Tag, "make">>(foreign, {
      make: "function",
    });
    const ForeignTeam = duplicate.make("team", Schema.String);
    expect(() => declarations([ForeignTeam])).toThrow("canonical");
    expect(() => normalize([ForeignTeam("foreign")])).toThrow("canonical");
    expect(
      await Effect.runPromise(
        ForeignTeam.value().pipe(
          Effect.provideService(Tag.Values, { team: "host" })
        )
      )
    ).toEqual(Option.some("host"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Ordered publisher and installed-extension integration. */
import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

import { digest } from "../src/extension-archive.ts";
import { cli, operation, start } from "./fixtures/cli.ts";
import {
  archiveFixture,
  fixtureManifest,
} from "./fixtures/extension-archive.ts";
import { typescript, workspace } from "./fixtures/published-extension.ts";

const OperationAccepted = Schema.Struct({ operationId: Schema.String });
const TaskResult = Schema.Struct({ result: Schema.Unknown });

test("installed extensions share reader service and query schemas with application and host", async () => {
  const base = await mkdtemp(
    path.join(tmpdir(), "effectory-reader-extension-")
  );
  const publisher = path.join(base, "publisher");
  const repository = path.join(base, "consumer");
  const children: Awaited<ReturnType<typeof start>>[] = [];
  try {
    await mkdir(publisher);
    await mkdir(repository);
    await symlink(
      path.join(workspace, "node_modules"),
      path.join(publisher, "node_modules"),
      "dir"
    );
    await writeFile(
      path.join(publisher, "contracts.mts"),
      `
import { Artifact } from "@offtree/effectory-sdk";
import { ArtifactReader } from "@offtree/effectory-sdk/ArtifactReader";
import * as ArtifactQuery from "@offtree/effectory-sdk/ArtifactQuery";
import { Effect, Schema } from "effect";
export const Value=Artifact.make({id:"fixture/reader/value",version:1,schema:Schema.Int});
export const read=(ref:typeof Value.refSchema.Type)=>Effect.gen(function*(){return yield* (yield* ArtifactReader).get(Value,ref);});
export const contracts={id:"fixture/reader",version:"1.0.0",tasks:{},workflows:{},artifacts:{Value},read,Reader:ArtifactReader,Query:ArtifactQuery.Query};
`
    );
    await writeFile(
      path.join(publisher, "extension.mts"),
      'import {Extension} from "@offtree/effectory-sdk";import {Value} from "./contracts.mjs";export default Extension.make({id:"fixture/reader",version:"1.0.0",artifacts:{Value}});'
    );
    await typescript(publisher, ["contracts.mts", "extension.mts"], true);
    const built = await Bun.build({
      entrypoints: [
        path.join(publisher, "contracts.mts"),
        path.join(publisher, "extension.mts"),
      ],
      external: [
        "effect",
        "effect/*",
        "@offtree/effectory-sdk",
        "@offtree/effectory-sdk/*",
      ],
      format: "esm",
      naming: {
        asset: "[name]-[hash].[ext]",
        chunk: "chunk-[hash].mjs",
        entry: "[name].mjs",
      },
      outdir: path.join(publisher, "dist"),
      splitting: true,
      target: "bun",
    });
    expect(built.success).toBe(true);
    const files = Object.fromEntries(
      await Promise.all(
        (await readdir(path.join(publisher, "dist"))).map(
          async (name) =>
            [
              name,
              await readFile(path.join(publisher, "dist", name), "utf-8"),
            ] as const
        )
      )
    );
    const manifest = {
      ...fixtureManifest,
      contributions: {
        ...fixtureManifest.contributions,
        artifacts: [{ id: "fixture/reader/value", name: "Value", version: 1 }],
      },
      files: Object.fromEntries(
        Object.entries(files).map(([name, value]) => [name, digest(value)])
      ),
      id: "fixture/reader",
    };
    const archive = await archiveFixture(manifest, files);
    const archivePath = path.join(base, "reader.tgz");
    await writeFile(archivePath, archive);
    const bin = path.join(base, "bin");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "gh"),
      `#!${process.execPath}\nconst endpoint=process.argv[5];if(endpoint.includes("/commits/"))process.stdout.write(JSON.stringify({sha:"a".repeat(40)}));else if(endpoint.includes("/releases/assets/"))process.stdout.write(await Bun.file(${JSON.stringify(archivePath)}).bytes());else process.stdout.write(JSON.stringify({id:1,draft:false,tag_name:"v1",assets:[{id:1,name:"effectory.tgz",size:${archive.length}}]}));`,
      { mode: 0o700 }
    );
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    await writeFile(
      path.join(repository, "effectory.ts"),
      'import {Application} from "@offtree/effectory-sdk";export default Application.make({});'
    );
    const initial = await start(repository, environment);
    children.push(initial);
    const added = Schema.decodeUnknownSync(OperationAccepted)(
      await cli(repository, [
        "extension",
        "add",
        "github:fixture/reader@v1",
        "--asset",
        "effectory.tgz",
        "--as",
        "Reads",
        "--trust",
      ])
    );
    expect((await operation(repository, added.operationId)).status).toBe(
      "Succeeded"
    );
    await symlink(
      path.join(workspace, "node_modules"),
      path.join(repository, "node_modules"),
      "dir"
    );
    await writeFile(
      path.join(repository, "effectory.ts"),
      `
import {Application,ArtifactReader,ArtifactQuery,ArtifactReadError,ArtifactUnavailable,ArtifactStorage,Extension,Task} from "@offtree/effectory-sdk";
import {Effect,Schema} from "effect";
import {Reads} from "./effectory.extensions.ts";
if(Reads.exports.Reader!==ArtifactReader || Reads.exports.Query!==ArtifactQuery.Query)throw new Error("SDK modules were duplicated");
const Value=Reads.artifacts.Value;
const RoundTrip=Task.make({id:"round-trip",version:1,input:Schema.Null,success:Schema.Int,error:Schema.Union([ArtifactReadError,ArtifactUnavailable]),replay:"idempotent",outputs:{value:Value}},()=>Effect.gen(function*(){const ref=yield* (yield* ArtifactStorage).publish(Value,42,{key:"value"});return yield* Reads.exports.read(ref);}));
export default Application.make({tasks:[RoundTrip],extensions:[Extension.use(Reads)]}) satisfies Application.Application<never>;
`
    );
    await typescript(repository, ["effectory.ts"]);
    initial.kill("SIGKILL");
    await initial.exited;
    children.push(await start(repository, environment));
    const result = Schema.decodeUnknownSync(TaskResult)(
      await cli(repository, ["task", "run", "round-trip", "--input", "null"])
    );
    expect(result.result).toBe(42);
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
      })
    );
    await rm(base, { force: true, recursive: true });
  }
}, 120_000);

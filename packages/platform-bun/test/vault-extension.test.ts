/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Sequential package build and process integration proof. */
import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
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
const TaskRun = Schema.Struct({ result: Schema.Unknown, runId: Schema.String });

test("installed lazy vault provider preserves canonical definitions and reloads after real daemon death", async () => {
  const base = await mkdtemp(
    path.join(os.tmpdir(), "effectory-vault-extension-")
  );
  const repository = path.join(base, "consumer");
  const publisher = path.join(base, "publisher");
  const children: Awaited<ReturnType<typeof start>>[] = [];
  try {
    await mkdir(repository);
    await mkdir(publisher);
    await symlink(
      path.join(workspace, "node_modules"),
      path.join(publisher, "node_modules"),
      "dir"
    );
    await writeFile(
      path.join(publisher, "contracts.mts"),
      `
import { Vault } from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";
export const Credentials = Vault.make({id:"extension/credentials",secrets:{token:Schema.NonEmptyString}});
export const provider = (filename:string): Vault.Implementation<Vault.VaultUnavailable> => (spec) => Effect.gen(function*(){
  const module = yield* Effect.tryPromise({try:()=>import("./provider.mjs"),catch:()=>new Vault.VaultUnavailable({vault:spec.id,reason:"Unreachable"})});
  return yield* module.make(spec,filename);
});
export const read = () => Effect.as(Credentials.get("token"), "extension-read");
export const contracts = {id:"fixture/vault",version:"1.0.0",tasks:{},workflows:{},artifacts:{},Credentials,provider,read};
`
    );
    await writeFile(
      path.join(publisher, "provider.mts"),
      `
import { appendFileSync, readFileSync } from "node:fs";
import { Vault } from "@offtree/effectory-sdk";
import { Effect, Option, Redacted } from "effect";
const marker=process.env.EFFECTORY_VAULT_PROBE_MARKER;
if(marker) appendFileSync(marker,"loaded\\n");
export const make = (spec:Vault.ImplementationSpec,filename:string) => Effect.gen(function*(){
  yield* Effect.acquireRelease(Effect.sync(()=>{if(marker)appendFileSync(marker,"acquired\\n")}),()=>Effect.sync(()=>{if(marker)appendFileSync(marker,"released\\n")}));
  return {providerId:"fixture/vault",read: (_key:string)=>Effect.gen(function*(){
    yield* Effect.logInfo("PROVIDER_INTERNAL_LOG");
    const value=yield* Effect.try({try:()=>readFileSync(filename,"utf8"),catch:()=>new Vault.VaultUnavailable({vault:spec.id,reason:"Unreachable"})});
    return Option.some(Redacted.make(value));
  })} satisfies Vault.Backend;
});
`
    );
    await writeFile(
      path.join(publisher, "extension.mts"),
      'import { Extension } from "@offtree/effectory-sdk"; export default Extension.make({id:"fixture/vault",version:"1.0.0"});'
    );
    await typescript(
      publisher,
      ["contracts.mts", "provider.mts", "extension.mts"],
      true
    );
    const build = await Bun.build({
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
    expect(build.success).toBe(true);
    const files = Object.fromEntries(
      await Promise.all(
        (await readdir(path.join(publisher, "dist"))).map(
          async (file) =>
            [
              file,
              await readFile(path.join(publisher, "dist", file), "utf-8"),
            ] as const
        )
      )
    );
    const manifest = {
      ...fixtureManifest,
      files: Object.fromEntries(
        Object.entries(files).map(([file, value]) => [file, digest(value)])
      ),
      id: "fixture/vault",
    };
    const archive = await archiveFixture(manifest, files);
    const archivePath = path.join(base, "vault.tgz");
    await writeFile(archivePath, archive);
    const bin = path.join(base, "bin");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "gh"),
      `#!${process.execPath}\nconst endpoint=process.argv[5]; if(endpoint.includes("/commits/"))process.stdout.write(JSON.stringify({sha:"a".repeat(40)})); else if(endpoint.includes("/releases/assets/"))process.stdout.write(await Bun.file(${JSON.stringify(archivePath)}).bytes()); else process.stdout.write(JSON.stringify({id:1,draft:false,tag_name:"v1",assets:[{id:1,name:"effectory.tgz",size:${archive.length}}]}));`,
      { mode: 0o700 }
    );
    const marker = path.join(base, "provider.log");
    const secretFile = path.join(base, "value.txt");
    await writeFile(secretFile, "CANARY-extension-provider-value");
    const environment = {
      ...process.env,
      EFFECTORY_VAULT_PROBE_MARKER: marker,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    await writeFile(
      path.join(repository, "effectory.ts"),
      'import {Application} from "@offtree/effectory-sdk";export default Application.make({});'
    );
    const initial = await start(repository, environment);
    children.push(initial);
    const add = Schema.decodeUnknownSync(OperationAccepted)(
      await cli(repository, [
        "extension",
        "add",
        "github:fixture/vault@v1",
        "--as",
        "Secrets",
        "--trust",
      ])
    );
    expect((await operation(repository, add.operationId)).status).toBe(
      "Succeeded"
    );
    expect(await Bun.file(marker).exists()).toBe(false);
    await symlink(
      path.join(workspace, "node_modules"),
      path.join(repository, "node_modules"),
      "dir"
    );
    await writeFile(
      path.join(repository, "effectory.ts"),
      `
import {Application,Extension,Task,Vault} from "@offtree/effectory-sdk";
import {Schema} from "effect";
import {Secrets} from "./effectory.extensions.ts";
const Read=Task.make({id:"read",version:1,replay:"idempotent",input:Schema.Null,success:Schema.String,error:Vault.Errors},()=>Secrets.exports.read());
export default Application.make({tasks:[Read],vaults:[Secrets.exports.Credentials],extensions:[Extension.use(Secrets)]}).provide(Vault.layer(Secrets.exports.Credentials,Secrets.exports.provider(${JSON.stringify(secretFile)}))) satisfies Application.Application<never,Vault.VaultUnavailable | import("@offtree/effectory-sdk").DefinitionError>;
`
    );
    await typescript(repository, ["effectory.ts"]);
    initial.kill("SIGKILL");
    await initial.exited;
    const first = await start(repository, environment);
    children.push(first);
    const firstRun = Schema.decodeUnknownSync(TaskRun)(
      await cli(repository, ["task", "run", "read", "--input", "null"])
    );
    expect(firstRun.result).toBe("extension-read");
    expect(
      JSON.stringify(await cli(repository, ["run", "logs", firstRun.runId]))
    ).not.toContain("PROVIDER_INTERNAL_LOG");
    expect(await readFile(marker, "utf-8")).toContain("acquired");
    first.kill("SIGKILL");
    await first.exited;
    const restarted = await start(repository, environment);
    children.push(restarted);
    expect(
      Schema.decodeUnknownSync(TaskRun)(
        await cli(repository, ["task", "run", "read", "--input", "null"])
      ).result
    ).toBe("extension-read");
    await cli(repository, ["daemon", "stop"]);
    await restarted.exited;
    expect(await readFile(marker, "utf-8")).toContain("released");
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
    await rm(base, { force: true, recursive: true });
  }
}, 120_000);

/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Sequential real-daemon install/restart lifecycle. */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

import {
  cli,
  operation,
  start,
} from "../../../packages/platform-bun/test/fixtures/cli.ts";
import {
  typescript,
  workspace,
} from "../../../packages/platform-bun/test/fixtures/published-extension.ts";
import { buildAwsVaultExtension } from "../build.ts";

const SecretRequest = Schema.Struct({ SecretId: Schema.String });
const Operation = Schema.Struct({ operationId: Schema.String });
const Result = Schema.Struct({ result: Schema.Unknown });
const Run = Schema.Struct({ result: Schema.Unknown, runId: Schema.String });
const Started = Schema.Struct({ runId: Schema.String });
const RunState = Schema.Struct({
  error: Schema.optionalKey(Schema.Unknown),
  status: Schema.optionalKey(Schema.String),
});

test("real AWS extension installs, typechecks, defers auth, rotates and reloads in a new daemon", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "effectory-aws-extension-"));
  const repository = path.join(base, "consumer");
  const children: Awaited<ReturnType<typeof start>>[] = [];
  const requests: { SecretId: string }[] = [];
  let raw = "CANARY-installed-aws-value-1";
  const server = Bun.serve({
    fetch: async (request) => {
      requests.push(
        Schema.decodeUnknownSync(SecretRequest)(await request.json())
      );
      expect(request.headers.get("authorization")).toContain(
        "/eu-west-1/secretsmanager/aws4_request"
      );
      return Response.json({ SecretString: raw });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const built = await buildAwsVaultExtension(path.join(base, "release"));
    expect(built.manifest.id).toBe("offtree/aws-vault");
    expect(
      built.manifest.dependencyInventory.map((item) => item.name)
    ).toContain("@distilled.cloud/aws");
    await mkdir(repository);
    const bin = path.join(base, "bin");
    await mkdir(bin);
    const archive = await Bun.file(built.archive).bytes();
    await writeFile(
      path.join(bin, "gh"),
      `#!${process.execPath}\nconst endpoint=process.argv[5]; if(endpoint.includes("/commits/"))process.stdout.write(JSON.stringify({sha:"a".repeat(40)})); else if(endpoint.includes("/releases/assets/"))process.stdout.write(await Bun.file(${JSON.stringify(built.archive)}).bytes()); else process.stdout.write(JSON.stringify({id:1,draft:false,tag_name:"v1",assets:[{id:1,name:"effectory-aws-vault.tgz",size:${archive.length}}]}));`,
      { mode: 0o700 }
    );
    // No ambient AWS profile, credentials, endpoint or region is inherited.
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("AWS_"))
    );
    Object.assign(environment, {
      AWS_CONFIG_FILE: path.join(base, "empty-config"),
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_SHARED_CREDENTIALS_FILE: path.join(base, "empty-credentials"),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    await writeFile(path.join(base, "empty-config"), "");
    await writeFile(path.join(base, "empty-credentials"), "");
    await writeFile(
      path.join(repository, "effectory.ts"),
      'import {Application} from "@offtree/effectory-sdk";export default Application.make({});'
    );
    const initial = await start(repository, environment);
    children.push(initial);
    const add = Schema.decodeUnknownSync(Operation)(
      await cli(repository, [
        "extension",
        "add",
        "github:fixture/aws@v1",
        "--asset",
        "effectory-aws-vault.tgz",
        "--as",
        "AwsSecretsManager",
        "--trust",
      ])
    );
    expect((await operation(repository, add.operationId)).status).toBe(
      "Succeeded"
    );
    expect(requests).toHaveLength(0);
    await symlink(
      path.join(workspace, "node_modules"),
      path.join(repository, "node_modules"),
      "dir"
    );
    await writeFile(
      path.join(repository, "effectory.ts"),
      `
import { Application, Extension, Task, Vault } from "@offtree/effectory-sdk";
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { AwsSecretsManager } from "./effectory.extensions.ts";
const Credentials = Vault.make({ id: "credentials", secrets: { token: Schema.String } });
const Read = Task.make({ id: "read", version: 1, replay: "idempotent", input: Schema.String, success: Schema.Boolean, error: Vault.Errors }, (input) => Effect.map(Credentials.get("token"), value => Redacted.value(value) === input));
const Leak = Task.make({ id: "leak", version: 1, replay: "idempotent", input: Schema.Null, success: Schema.String, error: Vault.Errors }, () => Effect.map(Credentials.get("token"), Redacted.value));
// Only the transport is redirected; Distilled still signs and decodes requests.
const localFetch = Object.assign((_url: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(${JSON.stringify(`http://127.0.0.1:${server.port}/`)}, init), { preconnect: fetch.preconnect });
export default Application.make({ tasks: [Read, Leak], vaults: [Credentials], extensions: [Extension.use(AwsSecretsManager)] })
.provide(Layer.mergeAll(Vault.layer(Credentials, AwsSecretsManager.exports.make({ region: "eu-west-1", secrets: { token: "example/token" } })), Layer.succeed(FetchHttpClient.Fetch, localFetch))) satisfies Application.Application<never>;
`
    );
    await typescript(repository, ["effectory.ts"]);
    initial.kill("SIGKILL");
    await initial.exited;
    // Building the saved revision and describing keys must work without credentials.
    const noCredentials = await start(repository, environment);
    children.push(noCredentials);
    const description = JSON.stringify(
      await cli(repository, ["vault", "describe", "credentials"])
    );
    expect(description).toContain("offtree/aws-vault");
    expect(requests).toHaveLength(0);
    await cli(repository, ["daemon", "stop"]);
    await noCredentials.exited;
    Object.assign(environment, {
      AWS_ACCESS_KEY_ID: "SYNTHETIC",
      AWS_SECRET_ACCESS_KEY: "SYNTHETIC",
    });
    const first = await start(repository, environment);
    children.push(first);
    const run = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "task",
        "run",
        "read",
        "--input",
        JSON.stringify(raw),
      ])
    );
    expect(run.result).toBe(true);
    raw = "CANARY-installed-aws-value-2";
    expect(
      Schema.decodeUnknownSync(Result)(
        await cli(repository, [
          "task",
          "run",
          "read",
          "--input",
          JSON.stringify(raw),
        ])
      ).result
    ).toBe(true);
    expect(requests).toHaveLength(2);
    expect(
      requests.every((request) => request.SecretId === "example/token")
    ).toBe(true);
    expect(
      JSON.stringify(await cli(repository, ["run", "logs", run.runId]))
    ).not.toContain("CANARY-");
    const leak = Schema.decodeUnknownSync(Started)(
      await cli(repository, [
        "task",
        "run",
        "leak",
        "--input",
        "null",
        "--background",
      ])
    );
    let failure: typeof RunState.Type = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      failure = Schema.decodeUnknownSync(RunState)(
        await cli(repository, ["run", "get", leak.runId])
      );
      if (failure.status === "Failed") {
        break;
      }
      await Bun.sleep(50);
    }
    expect(failure.status).toBe("Failed");
    expect(JSON.stringify(failure.error)).toContain("SecretInOutput");
    expect(JSON.stringify(failure.error)).not.toContain(raw);
    first.kill("SIGKILL");
    await first.exited;
    const restarted = await start(repository, environment);
    children.push(restarted);
    expect(
      Schema.decodeUnknownSync(Result)(
        await cli(repository, [
          "task",
          "run",
          "read",
          "--input",
          JSON.stringify(raw),
        ])
      ).result
    ).toBe(true);
    await cli(repository, ["daemon", "stop"]);
    await restarted.exited;
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
    await server.stop(true);
    await rm(base, { force: true, recursive: true });
  }
}, 180_000);

/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Sequential subprocess integration checks. */
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { effectory, start } from "./fixtures/cli.ts";

test("the interpreter guards second encoding and retained-revision vault administration", async () => {
  const base = await mkdtemp(
    path.join(os.tmpdir(), "effectory-vault-encoding-")
  );
  const repository = path.join(base, "repo");
  await mkdir(repository);
  const env = { ...process.env, EFFECTORY_KEY_DIR: path.join(base, "keys") };
  const children: Awaited<ReturnType<typeof start>>[] = [];
  const invoke = async (args: string[]) => {
    const child = Bun.spawn(
      [...effectory, ...args, "--repository", repository, "--json"],
      { env, stderr: "pipe", stdout: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      code,
      stderr,
      stdout,
      value: stdout.trim()
        ? (JSON.parse(stdout) as Record<string, unknown>)
        : undefined,
    };
  };
  try {
    const application = `
import {Application,Task,Vault} from "@offtree/effectory-sdk";
import {Effect,Redacted,Schema,SchemaGetter} from "effect";
const Credentials=Vault.make({id:"credentials",secrets:{token:Schema.String}});
let value=""; let encodes=0;
const Success=Schema.String.pipe(Schema.decodeTo(Schema.String,{decode:SchemaGetter.transform((s:string)=>s),encode:SchemaGetter.transform((_s:string)=>++encodes===1?"safe":value)}));
const Read=Task.make({id:"read",version:1,replay:"idempotent",input:Schema.Null,success:Success,error:Vault.Errors},()=>Effect.gen(function*(){value=Redacted.value(yield* Credentials.get("token"));return "safe"}));
export default Application.make({tasks:[Read],vaults:[Credentials]}).provide(Vault.layer(Credentials,Vault.local));`;
    await writeFile(path.join(repository, "effectory.ts"), application);
    const first = await start(repository, env);
    children.push(first);
    const initialized = await invoke(["vault", "init", "credentials"]);
    expect(initialized.code).toBe(0);
    const revision = String(initialized.value?.revision);
    const token = "CANARY-second-encoding-secret-123456789";
    const filename = path.join(base, "secret.txt");
    await writeFile(filename, token);
    const mutation = [
      "vault",
      "put",
      "credentials",
      "token",
      "--file",
      filename,
      "--if-version",
      "0",
      "--request-key",
      "first",
    ];
    expect((await invoke(mutation)).code).toBe(0);
    const outcome = await invoke(["task", "run", "read", "--input", "null"]);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stdout).toContain("SecretInOutput");
    expect(outcome.stdout + outcome.stderr).not.toContain(token);
    first.kill("SIGKILL");
    await first.exited;
    await writeFile(
      path.join(repository, "effectory.ts"),
      application.replace("Vault.local", 'Vault.memory({token:"new-provider"})')
    );
    children.push(await start(repository, env));
    const current = await invoke(mutation);
    expect(current.code).toBe(2);
    expect(current.stderr).toContain("read-only");
    const prior = await invoke([...mutation, "--revision", revision]);
    expect(prior.code).toBe(0);
    expect(prior.value?.replayed).toBe(true);
    const deleted = await invoke([
      "vault",
      "delete",
      "credentials",
      "token",
      "--if-version",
      "1",
      "--revision",
      revision,
    ]);
    expect(deleted.code).toBe(0);
    // The token originated in an external input file, never in a bundle or fixture source.
    const bytes = await readFile(
      path.join(repository, ".effectory/state.sqlite")
    );
    expect(bytes.includes(Buffer.from(token))).toBe(false);
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

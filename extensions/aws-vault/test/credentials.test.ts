/* oxlint-disable no-await-in-loop -- Bounded process cleanup polling. */
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("default chain defers credential_process until read and timeout terminates the direct process", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-aws-credentials-")
  );
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await symlink(
      path.resolve(import.meta.dir, "../../../node_modules"),
      path.join(directory, "node_modules"),
      "dir"
    );
    const marker = path.join(directory, "started");
    const stopped = path.join(directory, "stopped");
    const helper = path.join(directory, "credential.ts");
    await writeFile(
      helper,
      `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on("SIGTERM",()=>{writeFileSync(${JSON.stringify(stopped)},"stopped");process.exit(0)});setInterval(()=>{},1000);`
    );
    const config = path.join(directory, "config");
    const credentials = path.join(directory, "credentials");
    // No region in profile or environment: the adapter must provide it to the chain.
    await writeFile(
      config,
      `[profile fixture]\ncredential_process = exec ${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}\n`
    );
    await writeFile(credentials, "");
    const worker = path.join(directory, "worker.ts");
    await writeFile(
      worker,
      `
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {Vault} from "@offtree/effectory-sdk";
import {Cause,Effect,Exit,Layer,Schema} from "effect";
import {make} from ${JSON.stringify(path.resolve(import.meta.dir, "../src/contracts.ts"))};
const Def=Vault.make({id:"process-proof",secrets:{token:Schema.String}});
let requests=0; globalThis.fetch=Object.assign(async()=>{requests += 1;throw new Error("unexpected network")},{preconnect:fetch.preconnect});
const layer=Vault.layer(Def,make({region:"eu-west-1",secrets:{token:"never-sent"},requestTimeout:750}));
await Effect.runPromise(Effect.scoped(Effect.gen(function*(){const services=yield* Layer.build(layer);assert(!existsSync(${JSON.stringify(marker)}));const exit=yield* Effect.exit(Def.get("token").pipe(Effect.provideContext(services)));assert(Exit.isFailure(exit));if(Exit.isFailure(exit))assert((Cause.pretty(exit.cause)+JSON.stringify(exit.cause)).includes("Unreachable"),Cause.pretty(exit.cause)+JSON.stringify(exit.cause));})));
assert.equal(requests,0);assert.equal(process.env.AWS_REGION,undefined);assert(existsSync(${JSON.stringify(marker)}));
`
    );
    child = Bun.spawn([process.execPath, worker], {
      env: {
        AWS_CONFIG_FILE: config,
        AWS_EC2_METADATA_DISABLED: "true",
        AWS_PROFILE: "fixture",
        AWS_SHARED_CREDENTIALS_FILE: credentials,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr, stdout }).toEqual({
      code: 0,
      stderr: "",
      stdout: "",
    });
    for (let i = 0; i < 50 && !(await Bun.file(stopped).exists()); i += 1) {
      await Bun.sleep(20);
    }
    expect(await Bun.file(stopped).exists()).toBe(true);
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    // Also clean the synthetic credential process if an assertion regresses.
    try {
      if (!(await Bun.file(path.join(directory, "stopped")).exists())) {
        const pid = Number(
          await readFile(path.join(directory, "started"), "utf-8")
        );
        process.kill(pid, "SIGKILL");
      }
    } catch {
      /* Already exited or never started. */
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 15_000);

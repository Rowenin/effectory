import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ExtensionOperation } from "@effectory/runtime/extension-protocol";
import { Schema } from "effect";

import { RevisionReclaimPlan } from "../src/revision-reclaim-record.ts";
import { cli, operation, start } from "./fixtures/cli.ts";
import { publishedExtension } from "./fixtures/published-extension.ts";

test("completed extension receipt replays after its old application bundle is reclaimed without fetching or recreating code", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-reclaim-extension-")
  );
  const repository = path.join(directory, "repo");
  const children: Awaited<ReturnType<typeof start>>[] = [];
  try {
    const packaged = await publishedExtension(path.join(directory, "package"));
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    await mkdir(repository);
    const calls = path.join(directory, "unexpected-fetch");
    const gh = path.join(bin, "gh");
    await writeFile(
      gh,
      `#!${process.execPath}\nconst endpoint=process.argv[5];
if(endpoint.includes("/commits/")){process.stdout.write(JSON.stringify({sha:"a".repeat(40)}));}
else if(endpoint.includes("/releases/assets/")){process.stdout.write(await Bun.file(${JSON.stringify(path.join(directory, "package/bundle.tgz"))}).bytes());}
else{process.stdout.write(JSON.stringify({id:1,draft:false,tag_name:"v1",assets:[{id:1,name:"effectory.tgz",size:${packaged.archive.length}}]}));}
`,
      { mode: 0o700 }
    );
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    await writeFile(
      path.join(repository, "effectory.ts"),
      'import {Application} from "@offtree/effectory-sdk"; export default Application.make({});'
    );
    const first = await start(repository, environment);
    children.push(first);
    const args = [
      "extension",
      "add",
      "github:fixture/tools@v1",
      "--asset",
      "effectory.tgz",
      "--as",
      "Tools",
      "--trust",
      "--request-key",
      "saved-receipt",
    ];
    const accepted = Schema.decodeUnknownSync(ExtensionOperation)(
      await cli(repository, args)
    );
    const completed = await operation(repository, accepted.operationId);
    expect(completed.status, JSON.stringify(completed.error)).toBe("Succeeded");
    expect(completed.result?.applicationRevision).toBe(
      completed.baseApplicationRevision
    );
    await cli(repository, ["daemon", "stop"]);
    await first.exited;
    // A different, unused source revision moves the active/scheduler pointers.
    await writeFile(
      path.join(repository, "effectory.ts"),
      'import {Application,Task} from "@offtree/effectory-sdk"; import {Effect,Schema} from "effect"; const task=Task.make({id:"new",version:1,input:Schema.Null,success:Schema.Null,error:Schema.Never,replay:"idempotent"},()=>Effect.succeed(null)); export default Application.make({tasks:[task]});'
    );
    const second = await start(repository, environment);
    children.push(second);
    await cli(repository, ["daemon", "stop"]);
    await second.exited;
    const plan = Schema.decodeUnknownSync(RevisionReclaimPlan)(
      await cli(repository, [
        "revision",
        "reclaim",
        "plan",
        "--revision",
        completed.baseApplicationRevision,
      ])
    );
    expect(plan.status).toBe("Ready");
    await cli(repository, ["revision", "reclaim", "apply", plan.planId]);
    await writeFile(
      gh,
      `#!${process.execPath}\nawait Bun.write(${JSON.stringify(calls)},"unexpected network operation");process.exit(99);`,
      { mode: 0o700 }
    );
    const third = await start(repository, environment);
    children.push(third);
    expect(
      await cli(repository, ["operation", "get", completed.operationId])
    ).toEqual(completed);
    expect(
      await cli(repository, [
        ...args,
        "--expected-revision",
        completed.expectedRevision,
      ])
    ).toEqual(completed);
    expect(existsSync(calls)).toBe(false);
    expect(
      existsSync(
        path.join(
          repository,
          ".effectory",
          "revisions",
          completed.baseApplicationRevision
        )
      )
    ).toBe(false);
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
      })
    );
    await rm(directory, { force: true, recursive: true });
  }
}, 120_000);

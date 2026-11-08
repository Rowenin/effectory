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

import { digest } from "../src/extension-archive.ts";
import { cli, operation, start } from "./fixtures/cli.ts";
import {
  archiveFixture,
  fixtureManifest,
} from "./fixtures/extension-archive.ts";
import { typescript, workspace } from "./fixtures/published-extension.ts";

test("installed typed and generic reporters preserve canonical contracts across the facade and daemon restart", async () => {
  const base = await mkdtemp(
    path.join(os.tmpdir(), "effectory-reports-extension-")
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
import {Report,Task,Workflow} from "@offtree/effectory-sdk";
import {Effect,Schema} from "effect";
export const Source=Task.contract({id:"fixture/reports/source",version:1,input:Schema.Number,success:Schema.Number,error:Schema.Never,replay:"idempotent"});
export const Typed=Task.contract({id:"fixture/reports/typed",version:1,input:Report.sourceOf(Source),success:Report.result(Schema.String),error:Schema.Never,replay:"idempotent"});
export const Generic=Task.contract({id:"fixture/reports/generic",version:1,input:Report.Source,success:Report.result(Schema.String),error:Schema.Never,replay:"idempotent"});
export const Child=Workflow.make({id:"fixture/reports/child",version:1,input:Schema.Number,success:Schema.Number,error:Schema.Never},Effect.gen(function*(){const g=yield* Workflow.Builder;return yield* g.task("source",Source,yield* g.input(Schema.Number));}));
export const contracts={id:"fixture/reports",version:"1.0.0",tasks:{Source,Typed,Generic},workflows:{Child},artifacts:{}};
`
    );
    await writeFile(
      path.join(publisher, "extension.mts"),
      `
import {Extension,Report,Task} from "@offtree/effectory-sdk";
import {Effect} from "effect";
import {Source,Typed,Generic,Child} from "./contracts.mjs";
export default Extension.make({id:"fixture/reports",version:"1.0.0",workflows:{Child},tasks:{
Source:Task.make(Source.spec,n=>Effect.succeed(n+1)),
Typed:Task.make(Typed.spec,()=>Effect.gen(function*(){const history=yield* Report.History;const outcome=yield* history.outcome(Source);return {markdown:"typed",data:outcome._tag==="Succeeded"?String(outcome.value):outcome._tag}})),
Generic:Task.make(Generic.spec,()=>Effect.gen(function*(){const history=yield* Report.History;const outcome=yield* history.outcome();return {markdown:"generic",data:outcome._tag}}))
}});
`
    );
    await typescript(publisher, ["contracts.mts", "extension.mts"], true);
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
      contributions: {
        ...fixtureManifest.contributions,
        tasks: [
          { id: "fixture/reports/source", name: "Source", version: 1 },
          { id: "fixture/reports/typed", name: "Typed", version: 1 },
          { id: "fixture/reports/generic", name: "Generic", version: 1 },
        ],
        workflows: [{ id: "fixture/reports/child", name: "Child", version: 1 }],
      },
      files: Object.fromEntries(
        Object.entries(files).map(([file, value]) => [file, digest(value)])
      ),
      id: "fixture/reports",
    };
    const archive = await archiveFixture(manifest, files);
    const archivePath = path.join(base, "reports.tgz");
    await writeFile(archivePath, archive);
    const bin = path.join(base, "bin");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "gh"),
      `#!${process.execPath}\nconst endpoint=process.argv[5]; if(endpoint.includes("/commits/"))process.stdout.write(JSON.stringify({sha:"a".repeat(40)})); else if(endpoint.includes("/releases/assets/"))process.stdout.write(await Bun.file(${JSON.stringify(archivePath)}).bytes()); else process.stdout.write(JSON.stringify({id:1,draft:false,tag_name:"v1",assets:[{id:1,name:"effectory.tgz",size:${archive.length}}]}));`,
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
    const add = (await cli(repository, [
      "extension",
      "add",
      "github:fixture/reports@v1",
      "--as",
      "Reports",
      "--trust",
    ])) as { operationId: string };
    expect((await operation(repository, add.operationId)).status).toBe(
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
import {Application,Extension,Report} from "@offtree/effectory-sdk";
import {Reports} from "./effectory.extensions.ts";
export default Application.make({extensions:[Extension.use(Reports)],reports:[
Report.make({id:"typed",target:Reports.tasks.Source,task:Reports.tasks.Typed,scope:"run"}),
Report.make({id:"generic",target:Reports.tasks.Source,task:Reports.tasks.Generic,scope:"run"}),
Report.make({id:"workflow",target:Reports.workflows.Child,task:Reports.tasks.Generic,scope:"invocation"})
]}) satisfies Application.Application<never>;
`
    );
    await typescript(repository, ["effectory.ts"]);
    initial.kill("SIGKILL");
    await initial.exited;
    const first = await start(repository, environment);
    children.push(first);
    const source = (await cli(repository, [
      "task",
      "run",
      "fixture/reports/source",
      "--input",
      "41",
    ])) as { runId: string };
    expect(
      await cli(repository, ["report", "wait", source.runId])
    ).toMatchObject({ Succeeded: 2 });
    const page = (await cli(repository, ["report", "list", source.runId])) as {
      items: { attachmentId: string; reportId: string }[];
    };
    for (const record of page.items) {
      expect(
        await cli(repository, ["report", "get", record.reportId])
      ).toMatchObject({
        content: { data: record.attachmentId === "typed" ? "42" : "Succeeded" },
      });
    }
    const workflow = (await cli(repository, [
      "workflow",
      "run",
      "fixture/reports/child",
      "--input",
      "41",
    ])) as { runId: string };
    expect(
      await cli(repository, ["report", "wait", workflow.runId])
    ).toMatchObject({ Succeeded: 1 });
    const workflowPage = (await cli(repository, [
      "report",
      "list",
      workflow.runId,
    ])) as { items: { attachmentId: string; reportId: string }[] };
    page.items.push(...workflowPage.items);
    first.kill("SIGKILL");
    await first.exited;
    children.push(await start(repository, environment));
    for (const record of page.items) {
      const retry = (await cli(repository, [
        "report",
        "retry",
        record.reportId,
      ])) as { record: { reportId: string } };
      expect(
        await cli(repository, [
          "report",
          "wait",
          "--report",
          retry.record.reportId,
        ])
      ).toMatchObject({
        content: { data: record.attachmentId === "typed" ? "42" : "Succeeded" },
        record: { generation: 2, status: "Succeeded" },
      });
    }
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

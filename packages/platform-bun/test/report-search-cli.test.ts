/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Process-level operator flow is sequential. */
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Run } from "@effectory/runtime/protocol";
import { ReportSearchPage } from "@effectory/runtime/report-protocol";
import { Schema } from "effect";

import { cli, effectory, start } from "./fixtures/cli.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const application = `
import {Application,Report,Task,Workflow} from "@offtree/effectory-sdk";
import {Effect,Schema} from "effect";
const Source=Task.make({id:"source",version:1,input:Schema.Number,success:Schema.Number,error:Schema.Never,replay:"idempotent"},n=>Effect.succeed(n+1));
const Reporter=Task.make({id:"reporter",version:1,input:Report.sourceOf(Source),success:Report.result(Schema.Number),error:Schema.Never,replay:"idempotent"},()=>Effect.succeed({markdown:"# Report",data:42}));
const Deploy=Workflow.make({id:"deploy",version:1,input:Schema.Number,success:Schema.Number,error:Schema.Never},Effect.gen(function*(){const g=yield* Workflow.Builder;return yield* g.task("work",Source,yield* g.input(Schema.Number))}));
export default Application.make({tasks:[Source,Reporter],workflows:[Deploy],reports:[Report.make({id:"summary",target:Source,task:Reporter,scope:"run"}),Report.make({id:"step-summary",target:Source,task:Reporter,scope:"invocation"}),Report.make({id:"excluded",target:Source,task:Reporter,scope:"run",on:["Failed"]})]});
`;
test("report search CLI discovers across root runs, reads a result, continues pages and keeps machine output quiet", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-search-cli-")
  );
  let daemon: Awaited<ReturnType<typeof start>> | undefined;
  const command = async (args: string[]) => {
    const child = Bun.spawn(
      [...effectory, ...args, "--repository", repository],
      { stderr: "pipe", stdout: "pipe" }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stderr, stdout };
  };
  try {
    await writeFile(path.join(repository, "effectory.ts"), application);
    daemon = await start(repository);
    for (const kind of ["task", "workflow"]) {
      const root = Schema.decodeUnknownSync(Run)(
        await cli(repository, [
          kind,
          "run",
          kind === "task" ? "source" : "deploy",
          "--input",
          "1",
          "--tag",
          "team=platform",
        ])
      );
      await cli(repository, ["report", "wait", root.runId]);
    }
    const page = Schema.decodeUnknownSync(ReportSearchPage)(
      await cli(repository, [
        "report",
        "search",
        "summary",
        "--workflow",
        "deploy",
        "--task",
        "source",
        "--tag",
        "team=platform",
      ])
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.source.scope).toBe("invocation");
    const id = page.items[0]?.reportId;
    if (id === undefined) {
      throw new Error("Missing search result");
    }
    expect(await cli(repository, ["report", "get", id])).toMatchObject({
      content: { data: 42, markdown: "# Report" },
    });
    const both = Schema.decodeUnknownSync(ReportSearchPage)(
      await cli(repository, [
        "report",
        "search",
        "--status",
        "NotApplicable",
        "--status",
        "Succeeded",
      ])
    );
    expect(both.items.some((item) => item.status === "NotApplicable")).toBe(
      true
    );
    const human = await command([
      "report",
      "search",
      "summary",
      "--limit",
      "1",
    ]);
    expect(human.code).toBe(0);
    expect(human.stderr).toContain("Continue report search:");
    const first = Schema.decodeUnknownSync(ReportSearchPage)(
      JSON.parse(human.stdout)
    );
    expect(first.cursor).not.toBeNull();
    const line = human.stderr
      .split("\n")
      .find((value) => value.startsWith("effectory "));
    if (line === undefined) {
      throw new Error("Missing continuation command");
    }
    const continuation = Bun.spawn(
      [
        "/bin/zsh",
        "-c",
        line.replace(/^effectory /u, `${effectory.map(quote).join(" ")} `),
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const [continued, out, err] = await Promise.all([
      continuation.exited,
      new Response(continuation.stdout).text(),
      new Response(continuation.stderr).text(),
    ]);
    expect(continued).toBe(0);
    expect(err).not.toContain("Conflict");
    expect(
      Schema.decodeUnknownSync(ReportSearchPage)(JSON.parse(out)).items[0]
        ?.reportId
    ).not.toBe(first.items[0]?.reportId);
    expect(
      (await command(["report", "search", "summary", "--limit", "1", "--json"]))
        .stderr
    ).toBe("");
    expect(
      (
        await command([
          "report",
          "search",
          "--created-after",
          "2027",
          "--created-before",
          "2026",
        ])
      ).code
    ).toBe(2);
    expect(
      (await command(["report", "search", "--status", "NoSuchStatus"])).code
    ).toBe(2);
    expect(
      (await command(["report", "search", "--workflow", "absent"])).stderr
    ).toContain("exact and case-sensitive");
    await cli(repository, ["daemon", "stop"]);
    await daemon.exited;
    daemon = await start(repository);
    expect(
      Schema.decodeUnknownSync(ReportSearchPage)(
        await cli(repository, ["report", "search", "--workflow", "deploy"])
      ).items[0]?.reportId
    ).toBe(id);
  } finally {
    if (daemon?.exitCode === null) {
      daemon.kill("SIGKILL");
    }
    if (daemon) {
      await daemon.exited;
    }
    await rm(repository, { force: true, recursive: true });
  }
}, 120_000);

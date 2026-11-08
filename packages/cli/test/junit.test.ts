import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { OperationError, Run } from "@effectory/runtime/protocol";
import type { CheckRecord } from "@offtree/effectory-sdk/internal/check-schema";
import { Effect, Exit, Option, Schema } from "effect";

import {
  checkDestination,
  checkLaunch,
  checksPreflight,
} from "../src/checks.ts";
import { exportJUnit, junitLines, xml } from "../src/junit.ts";

function row(
  sequence: number,
  status: CheckRecord["status"],
  nodeId = "node"
): CheckRecord {
  return {
    attempt: 2,
    durationMillis: 123,
    entry: 3,
    finishedAt: "2026-11-06T00:00:00.000Z",
    id: `check-${sequence}`,
    message: "A & B < C\t\n\r😀\u0000\uD800",
    nodeId,
    runId: "run",
    sequence,
    severity: "low",
    startedAt: "2026-11-06T00:00:00.000Z",
    status,
    taskId: "verify",
  };
}
const run = Schema.decodeUnknownSync(Run)({
  acceptedAt: "2026-11-06T00:00:00.000Z",
  engineId: null,
  error: null,
  finishedAt: "2026-11-06T00:00:01.000Z",
  input: null,
  kind: "task",
  lastSequence: 0,
  requestKey: "request",
  result: true,
  revision: "revision",
  runId: "run",
  startedAt: "2026-11-06T00:00:00.000Z",
  status: "Succeeded",
  tags: {},
  targetId: "verify",
});

test("real XML parser verifies scalar repair, ordering, counts and outcome cases", async () => {
  const rows = [
    row(2, "Passed", "first"),
    row(1, "Failed"),
    row(3, "Error"),
    row(4, "Incomplete"),
  ];
  const content = [...junitLines(run, rows)].join("\n");
  const parser = Bun.spawn(
    [
      "python3",
      "-c",
      `import sys,xml.etree.ElementTree as E
r=E.fromstring(sys.stdin.read())
assert r.attrib['tests']=='5' and r.attrib['failures']=='1' and r.attrib['errors']=='2'
assert r.find('testsuite').attrib['name']=='first'
assert len(r.findall('.//testcase'))==5
assert r.find('.//failure').attrib['message']=='A & B < C\\t\\n\\r😀��'
assert len(r.findall('.//error'))==2
`,
    ],
    { stderr: "pipe", stdin: new Blob([content]), stdout: "pipe" }
  );
  const stderr = await new Response(parser.stderr).text();
  expect(await parser.exited).toBe(0);
  expect(stderr).toBe("");
  for (const status of [
    "Failed",
    "Cancelled",
    "TimedOut",
    "Rejected",
  ] as const) {
    expect([...junitLines({ ...run, status }, [])].join("\n")).toContain(
      `type="${status}"`
    );
  }
  expect(() => [...junitLines({ ...run, status: "Waiting" }, [])]).toThrow(
    "not terminal"
  );
  expect(() => [...junitLines(run, [row(1, "Running")])]).toThrow(
    "reconciliation"
  );
  expect(xml('"\uFFFF\uFFFE\u007F')).toBe("&quot;��\u007F");
});

test("export spools empty continuation pages, installs without overwrite and cleans up on read failure", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "effectory-junit-test-"));
  const output = path.join(directory, "result.xml");
  try {
    let reads = 0;
    const client = {
      RunChecks: () =>
        Effect.sync(() => {
          reads += 1;
          return {
            cursor: reads === 1 ? "next" : null,
            items: reads === 1 ? [] : [row(1, "Passed")],
            snapshot: 1,
          };
        }),
    };
    await Effect.runPromise(exportJUnit(client, run, output));
    expect(reads).toBe(2);
    expect(readFileSync(output, "utf-8")).toContain('tests="2"');
    expect(readdirSync(directory)).toEqual(["result.xml"]);
    writeFileSync(output, "existing");
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(exportJUnit(client, run, output))
      )
    ).toBe(true);
    expect(readFileSync(output, "utf-8")).toBe("existing");
    let pages = 0;
    const broken = {
      RunChecks: () =>
        Effect.suspend(() => {
          pages += 1;
          if (pages === 1) {
            return Effect.succeed({
              cursor: "next",
              items: [row(1, "Passed")],
              snapshot: 2,
            });
          }
          return Effect.fail(
            new OperationError({ code: "Unavailable", message: "page failed" })
          );
        }),
    };
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          exportJUnit(broken, run, path.join(directory, "failed.xml"))
        )
      )
    ).toBe(true);
    expect(readdirSync(directory)).toEqual(["result.xml"]);
    expect(Exit.isFailure(Effect.runSyncExit(checkDestination(output)))).toBe(
      true
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("check options refuse old daemons and conflicting flags before submission", async () => {
  const refused = await Effect.runPromiseExit(
    checksPreflight({
      SystemStatus: () => Effect.succeed({ capabilities: [] }),
    })
  );
  expect(Exit.isFailure(refused)).toBe(true);
  for (const config of [
    { background: true, junit: true, output: Option.none<string>() },
    { background: false, junit: false, output: Option.some("result.xml") },
  ]) {
    expect(Exit.isFailure(Effect.runSyncExit(checkLaunch(config, false)))).toBe(
      true
    );
  }
  expect(
    Exit.isFailure(
      Effect.runSyncExit(
        checkLaunch(
          { background: false, junit: true, output: Option.none() },
          true
        )
      )
    )
  ).toBe(true);
});

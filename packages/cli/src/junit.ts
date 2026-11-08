import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CheckListRequest,
  CheckPage,
} from "@effectory/runtime/check-protocol";
import { OperationError, terminal } from "@effectory/runtime/protocol";
import type { Run } from "@effectory/runtime/protocol";
import { CheckRecord } from "@offtree/effectory-sdk/internal/check-schema";
import { Console, Effect, Schema } from "effect";

import { writeTextLine } from "./text-line.ts";

/** XML 1.0 scalar validation precedes escaping, including isolated surrogates. */
export function xml(value: string): string {
  return Array.from(value, (character) => {
    const scalar = character.codePointAt(0) ?? 0;
    if (character === "\t") {
      return "&#9;";
    }
    if (character === "\n") {
      return "&#10;";
    }
    if (character === "\r") {
      return "&#13;";
    }
    if (
      scalar < 32 ||
      (scalar >= 0xd8_00 && scalar <= 0xdf_ff) ||
      scalar === 0xff_fe ||
      scalar === 0xff_ff
    ) {
      return "\uFFFD";
    }
    switch (character) {
      case "&": {
        return "&amp;";
      }
      case "<": {
        return "&lt;";
      }
      case ">": {
        return "&gt;";
      }
      case '"': {
        return "&quot;";
      }
      case "'": {
        return "&apos;";
      }
      default: {
        return character;
      }
    }
  }).join("");
}
function attempt<A>(body: () => A) {
  return Effect.try({
    catch: (cause) =>
      cause instanceof OperationError
        ? cause
        : new OperationError({
            code: "Unavailable",
            message: "JUnit file operation failed",
          }),
    try: body,
  });
}
const error = (code: OperationError["code"], message: string) =>
  new OperationError({ code, message });
function counts(rows: readonly CheckRecord[]) {
  return {
    errors: rows.filter(
      (row) => row.status === "Error" || row.status === "Incomplete"
    ).length,
    failures: rows.filter((row) => row.status === "Failed").length,
    tests: rows.length,
  };
}
function attributes(value: {
  tests: number;
  failures: number;
  errors: number;
}) {
  return `tests="${value.tests}" failures="${value.failures}" errors="${value.errors}" skipped="0"`;
}
function testcase(row: CheckRecord) {
  const name = xml(JSON.stringify([row.nodeId, row.id]));
  const properties = `<properties><property name="severity" value="${row.severity}"/><property name="attempt" value="${row.attempt}"/><property name="entry" value="${row.entry}"/></properties>`;
  let result = "";
  if (row.status === "Failed") {
    result = `<failure type="AssertionFailed" message="${xml(row.message)}"/>`;
  }
  if (row.status === "Error") {
    result =
      '<error type="EvaluationError" message="Assertion evaluation failed"/>';
  }
  if (row.status === "Incomplete") {
    result =
      '<error type="Incomplete" message="Assertion evaluation did not finish"/>';
  }
  return `<testcase name="${name}" classname="${xml(row.taskId)}"${row.durationMillis === null ? "" : ` time="${row.durationMillis / 1000}"`}>${properties}${result}</testcase>`;
}
export function* junitLines(
  run: Pick<Run, "runId" | "status">,
  input: readonly CheckRecord[]
) {
  if (!terminal.has(run.status)) {
    throw error(
      "Conflict",
      `Run is not terminal; inspect run get ${run.runId} or run watch ${run.runId}`
    );
  }
  if (input.some((row) => row.status === "Running")) {
    throw error(
      "Unavailable",
      "Check reconciliation is unfinished; retry the export"
    );
  }
  // RunChecks delivers invocation groups in their stored first-position order.
  const rows = input;
  const total = counts(rows);
  total.tests += 1;
  if (run.status !== "Succeeded") {
    total.errors += 1;
  }
  yield '<?xml version="1.0" encoding="UTF-8"?>';
  yield `<testsuites name="${xml(run.runId)}" ${attributes(total)}>`;
  const groups = new Map<string, CheckRecord[]>();
  for (const row of rows) {
    const group = groups.get(row.nodeId) ?? [];
    group.push(row);
    groups.set(row.nodeId, group);
  }
  for (const [node, group] of groups) {
    yield `<testsuite name="${xml(node)}" ${attributes(counts(group))}>`;
    for (const row of group) {
      yield testcase(row);
    }
    yield "</testsuite>";
  }
  yield `<testsuite name="run-outcome" tests="1" failures="0" errors="${run.status === "Succeeded" ? 0 : 1}" skipped="0"><testcase name="${xml(run.runId)}" classname="run-outcome">${run.status === "Succeeded" ? "" : `<error type="${run.status}" message="Run finished ${run.status}"/>`}</testcase></testsuite>`;
  yield "</testsuites>";
}

function write(file: number, value: string) {
  const bytes = Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(file, bytes, offset, bytes.length - offset);
    if (!written) {
      throw new Error("JUnit write made no progress");
    }
    offset += written;
  }
  return bytes.length;
}

/** Spool all pages before publishing any XML or installing a destination. */
export function exportJUnit<E, R>(
  client: {
    readonly RunChecks: (
      request: typeof CheckListRequest.Type
    ) => Effect.Effect<typeof CheckPage.Type, E, R>;
  },
  run: Run,
  destination?: string
) {
  return Effect.scoped(
    Effect.gen(function* () {
      if (!terminal.has(run.status)) {
        return yield* error(
          "Conflict",
          `Run is not terminal; inspect run get ${run.runId} or run watch ${run.runId}`
        );
      }
      const directory = yield* Effect.acquireRelease(
        attempt(() =>
          mkdtempSync(
            path.join(
              destination === undefined
                ? tmpdir()
                : path.dirname(path.resolve(destination)),
              ".effectory-junit-"
            )
          )
        ),
        (value) =>
          Effect.sync(() =>
            rmSync(value, { force: true, recursive: true })
          ).pipe(Effect.ignoreCause)
      );
      const spool = path.join(directory, "records.jsonl");
      const target = path.join(directory, "results.xml");
      const records = yield* Effect.acquireRelease(
        attempt(() => openSync(spool, "wx", 0o600)),
        (fd) => Effect.sync(() => closeSync(fd)).pipe(Effect.ignoreCause)
      );
      let cursor: string | null = null;
      let recordBytes = 0;
      do {
        const page: typeof CheckPage.Type = yield* client.RunChecks({
          attempts: "latest",
          limit: 200,
          runId: run.runId,
          ...(cursor === null ? {} : { cursor }),
        });
        recordBytes += yield* attempt(() =>
          page.items.reduce(
            (total, row) => total + write(records, `${JSON.stringify(row)}\n`),
            0
          )
        );
        if (recordBytes > 16_777_216) {
          return yield* error(
            "LimitExceeded",
            "Check export exceeds the record budget"
          );
        }
        ({ cursor } = page);
      } while (cursor !== null);
      const rows = yield* attempt(() =>
        readFileSync(spool, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((line) =>
            Schema.decodeUnknownSync(CheckRecord)(JSON.parse(line))
          )
      );
      const output = yield* Effect.acquireRelease(
        attempt(() => openSync(target, "wx", 0o600)),
        (fd) => Effect.sync(() => closeSync(fd)).pipe(Effect.ignoreCause)
      );
      yield* attempt(() => {
        let bytes = 0;
        for (const line of junitLines(run, rows)) {
          bytes += Buffer.byteLength(line) + 1;
          if (bytes > 134_217_728) {
            throw error("LimitExceeded", "JUnit XML exceeds 128 MiB");
          }
          write(output, `${line}\n`);
        }
        fsyncSync(output);
        if (destination !== undefined) {
          linkSync(target, path.resolve(destination));
          const parent = openSync(path.dirname(path.resolve(destination)), "r");
          try {
            fsyncSync(parent);
          } finally {
            closeSync(parent);
          }
        }
      });
      if (rows.length === 0) {
        yield* Console.error(
          "No assertion checks were recorded; JUnit contains only the run outcome."
        ).pipe(Effect.ignoreCause);
      }
      if (destination === undefined) {
        // The completed bounded document is emitted only after all reads and formatting succeed.
        for (const line of readFileSync(target, "utf-8")
          .trimEnd()
          .split("\n")) {
          yield* writeTextLine(line, process.stdout);
        }
      }
    })
  );
}

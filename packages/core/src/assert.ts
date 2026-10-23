/**
 * `Assert` records a check as an `AssertResult` record and never fails the
 * graph. The run's exit code comes from failed assertions at or above a
 * `--fail-on` threshold; `junit` renders them for CI.
 */
import { Effect, Schema } from "effect";

import * as Node from "./node.ts";
import type { NodeOptions, NodeRow, Registry } from "./node.ts";
import * as Output from "./output.ts";
import type { RecordRow, RunRow } from "./state.ts";
import type { Report, ReportContext } from "./workflow.ts";

export const SeveritySchema = Schema.Literals(["low", "medium", "high"]);
export type Severity = typeof SeveritySchema.Type;

/** `--fail-on`: the lowest severity that fails the run, or `none`. */
export type FailOn = Severity | "none";

export const AssertResultSchema = Schema.Struct({
  message: Schema.String,
  passed: Schema.Boolean,
  severity: SeveritySchema,
});
export type AssertResult = typeof AssertResultSchema.Type;

/** The record kind of assertion results. */
export const kind = "AssertResult";

const codec = Schema.toCodecJson(AssertResultSchema) as unknown as Schema.Codec<
  unknown,
  unknown
>;
const isAssertResult = Schema.is(AssertResultSchema);

export interface Definition {
  readonly that: Output.Input<boolean>;
  readonly message: Output.Input<string>;
  /** Default `high`. */
  readonly severity?: Severity;
}

const ranks: Record<Severity, number> = { high: 3, low: 1, medium: 2 };

/** `low` < `medium` < `high`. */
export const severityRank = (severity: Severity): number => ranks[severity];

const tolerant = <A>(value: Output.Input<A>) =>
  Output.isOutput(value) ? Output.optional(value as Output.Output<A>) : value;

const register = (
  name: string,
  definition: Definition,
  options?: NodeOptions
): Effect.Effect<Output.Output<boolean>, never, Registry> =>
  Effect.gen(function* registerAssert() {
    const defaults = yield* Node.Defaults;
    const upstream = new Set([
      ...Output.upstreamOf(definition.that),
      ...Output.upstreamOf(definition.message),
    ]);
    const result = yield* Node.register<AssertResult>({
      codec,
      execute: (ctx) =>
        Effect.gen(function* executeAssert() {
          const input = ctx.input as {
            readonly that: boolean | undefined;
            readonly message: string | undefined;
            readonly severity: Severity;
          };
          let missing = "";
          if (input.that === undefined || input.message === undefined) {
            const rows = yield* ctx.state.getNodes(ctx.runId);
            const absent = rows
              .filter(
                (row) => upstream.has(row.fqn) && row.status !== "succeeded"
              )
              .map((row) => row.fqn);
            missing =
              absent.length > 0
                ? `${absent.join(", ")} has no value`
                : "value is undefined";
          }
          if (input.that === undefined) {
            return Node.succeeded({
              message: `assertion input unavailable: ${missing}`,
              passed: false,
              severity: input.severity,
            });
          }
          return Node.succeeded({
            message: input.message ?? `message unavailable: ${missing}`,
            passed: input.that === true,
            severity: input.severity,
          });
        }),
      input: {
        message: tolerant(definition.message),
        severity: definition.severity ?? "high",
        that: tolerant(definition.that),
      },
      kind: "assert",
      name,
      options: {
        ...(defaults.runIf === undefined ? { runIf: "completed" } : {}),
        ...options,
      },
      record: true,
      reuse: "record",
      type: kind,
    });
    return result.passed;
  });

/** The latest AssertResult per FQN in `records`. */
const latestResults = (records: readonly RecordRow[]) => {
  const latest = new Map<string, RecordRow & { value: AssertResult }>();
  for (const record of records) {
    const current = latest.get(record.fqn);
    if (
      record.kind === kind &&
      isAssertResult(record.value) &&
      (current === undefined || record.id > current.id)
    ) {
      latest.set(record.fqn, record as RecordRow & { value: AssertResult });
    }
  }
  return [...latest.values()].toSorted((a, b) => a.id - b.id);
};

/** Failed AssertResult records at or above `failOn` (none for `none`). */
export const failures = (
  records: readonly RecordRow[],
  failOn: FailOn
): readonly (RecordRow & { readonly value: AssertResult })[] => {
  if (failOn === "none") {
    return [];
  }
  const threshold = severityRank(failOn);
  return latestResults(records).filter(
    (record) =>
      !record.value.passed && severityRank(record.value.severity) >= threshold
  );
};

/** Whether failed assertions fail the run. Default `failOn`: `low`, so any failure. */
export const shouldFail = (
  records: readonly RecordRow[],
  failOn: FailOn = "low"
): boolean => failures(records, failOn).length > 0;

/**
 * Process exit code for a finished run: 1 when the run failed or was
 * cancelled, or an assertion fails at `failOn`; otherwise 0 (including
 * suspended runs).
 */
export const exitCode = (
  ctx: { readonly run: RunRow; readonly records: readonly RecordRow[] },
  failOn: FailOn = "low"
): 0 | 1 => {
  if (ctx.run.status === "failed" || ctx.run.status === "cancelled") {
    return 1;
  }
  return shouldFail(ctx.records, failOn) ? 1 : 0;
};

const invalidXml =
  // oxlint-disable-next-line no-control-regex -- strips characters XML 1.0 forbids.
  /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;

/** Escape text for XML content and attribute values. */
export const escapeXml = (text: string): string =>
  text
    .replaceAll(invalidXml, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const attributes = (values: Record<string, string | number>) =>
  Object.entries(values)
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
    .join(" ");

/**
 * JUnit XML for one run: a `<testsuite>` per run with a `<testcase>` per
 * assertion (`<failure>` when it failed, typed by severity), a skipped
 * testcase per skipped Assert node, and an `<error>` testcase per failed
 * non-Assert node that did not allow failure.
 */
export const junit = (ctx: ReportContext): string => {
  const { run } = ctx;
  const cases: string[] = [];
  let failed = 0;
  let errors = 0;
  let skipped = 0;
  const results = latestResults(
    ctx.records.filter((record) => record.runId === run.id)
  );
  for (const record of results) {
    const head = `<testcase ${attributes({ classname: run.workflow, name: record.fqn })}`;
    if (record.value.passed) {
      cases.push(`${head}/>`);
    } else {
      failed += 1;
      cases.push(
        `${head}><failure ${attributes({ message: record.value.message, type: record.value.severity })}>${escapeXml(record.value.message)}</failure></testcase>`
      );
    }
  }
  const nodes: readonly NodeRow[] = ctx.nodes;
  for (const node of nodes) {
    const head = `<testcase ${attributes({ classname: run.workflow, name: node.fqn })}`;
    if (node.kind === "assert" && node.status === "skipped") {
      skipped += 1;
      cases.push(
        `${head}><skipped ${attributes({ message: node.reason ?? "skipped" })}/></testcase>`
      );
    } else if (node.status === "failed" && node.allowFailure !== true) {
      errors += 1;
      const message = node.error?.message ?? "failed";
      cases.push(
        `${head}><error ${attributes({ message, type: node.error?.tag ?? "Error" })}>${escapeXml(message)}</error></testcase>`
      );
    }
  }
  const counts = {
    errors,
    failures: failed,
    skipped,
    tests: cases.length,
  };
  const seconds = Math.max(0, (run.updatedAt - run.createdAt) / 1000);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites ${attributes({ name: run.collection, ...counts })}>`,
    `  <testsuite ${attributes({
      id: run.id,
      name: run.workflow,
      ...counts,
      time: seconds.toFixed(3),
      timestamp: new Date(run.createdAt).toISOString(),
    })}>`,
    `    <properties><property ${attributes({ name: "scope", value: run.scope })}/><property ${attributes({ name: "status", value: run.status })}/></properties>`,
    ...cases.map((line) => `    ${line}`),
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
};

/** A Report rendering `junit`: `Workflow.make(..., { reports: [Assert.junitReport] })`. */
export const junitReport: Report = {
  format: "junit",
  name: "junit",
  render: (ctx) => Effect.succeed(junit(ctx)),
};

/**
 * Record a check. Returns `Output<boolean>` (`passed`), for gating later
 * nodes with `when`. Runs with `runIf: "completed"` by default; an upstream
 * without a value makes the assertion fail instead of the node.
 *
 * ```ts
 * const ok = yield* Assert("tests-pass", {
 *   that: Output.map(test, (r) => r.exitCode === 0),
 *   message: "bun test exits 0",
 *   severity: "high",
 * });
 * ```
 */
export const Assert = Object.assign(register, {
  exitCode,
  failures,
  junit,
  junitReport,
  severityRank,
  shouldFail,
});

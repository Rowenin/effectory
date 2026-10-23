/* oxlint-disable max-classes-per-file -- the report errors live with Report. */
/**
 * Reports render a finished run's nodes and records into an artifact. The
 * engine renders a workflow's `reports` when the run finishes (also when it
 * fails) and stores each as a `Report` record at `<workflow>/report/<name>`.
 */
import { Data, Effect } from "effect";

import type { NodeRow } from "./node.ts";
import { State } from "./state.ts";
import type { RecordRow } from "./state.ts";
import type * as Workflow from "./workflow.ts";

export class InvalidReport extends Data.TaggedError("InvalidReport")<{
  readonly message: string;
}> {}

export class ReportNotFound extends Data.TaggedError("ReportNotFound")<{
  readonly message: string;
  readonly runId: string;
  readonly report: string;
}> {}

export type Format = Workflow.Report["format"];

const segment = /^[\w.@:#+-]+$/u;

/**
 * Define a report.
 *
 * ```ts
 * const failures = Report.make({
 *   name: "failures",
 *   render: ({ nodes }) => Effect.succeed(nodes.filter((n) => n.status === "failed").map((n) => n.fqn).join("\n")),
 * });
 * ```
 */
export const make = (options: {
  readonly name: string;
  readonly format?: Format;
  readonly render: Workflow.Report["render"];
}): Workflow.Report => {
  if (!segment.test(options.name)) {
    throw new InvalidReport({
      message: `Invalid report name "${options.name}": use letters, digits, and . _ - @ : # +`,
    });
  }
  return {
    format: options.format ?? "markdown",
    name: options.name,
    render: options.render,
  };
};

/** An assertion result as written by `Assert`. */
export interface Assertion {
  readonly fqn: string;
  readonly passed: boolean;
  readonly message: string;
  readonly severity: string;
}

const isAssertion = (
  record: RecordRow
): record is RecordRow & {
  readonly value: Omit<Assertion, "fqn">;
} => {
  const value = record.value as Record<string, unknown> | null;
  return (
    (record.kind === "AssertResult" || record.kind === "Assert") &&
    typeof value === "object" &&
    value !== null &&
    typeof value.passed === "boolean"
  );
};

/** Assertions among a run's records, oldest first. */
export const assertions = (
  records: readonly RecordRow[]
): readonly Assertion[] =>
  records
    .filter(isAssertion)
    .toSorted((a, b) => a.id - b.id)
    .map((record) => ({
      fqn: record.fqn,
      message: String(record.value.message ?? ""),
      passed: record.value.passed,
      severity: String(record.value.severity ?? ""),
    }));

const cell = (value: unknown) =>
  String(value ?? "")
    .replaceAll("|", String.raw`\|`)
    .replaceAll(/\r?\n/gu, " ");

const row = (values: readonly unknown[]) =>
  `| ${values.map(cell).join(" | ")} |`;

const nodeRow = (node: NodeRow) =>
  row([
    `\`${node.fqn}\``,
    node.type,
    node.status,
    node.attempt,
    node.error ? `${node.error.tag}: ${node.error.message}` : "",
  ]);

/** Markdown for a run: header, node table, and assertions. */
export const renderSummary = (ctx: Workflow.ReportContext): string => {
  const { run } = ctx;
  const lines = [
    `# ${run.workflow}: ${run.status}`,
    "",
    `- Run: \`${run.id}\``,
    `- Scope: \`${run.scope}\``,
    `- Status: ${run.status}`,
    ...(run.target === undefined ? [] : [`- Target: ${run.target}`]),
    ...(run.error === undefined ? [] : [`- Error: ${cell(run.error)}`]),
    "",
    "## Nodes",
    "",
    row(["Node", "Type", "Status", "Attempt", "Error"]),
    row(["---", "---", "---", "---", "---"]),
    ...ctx.nodes.map(nodeRow),
  ];
  const found = assertions(ctx.records);
  if (found.length > 0) {
    const passed = found.filter((assertion) => assertion.passed).length;
    lines.push(
      "",
      "## Assertions",
      "",
      `${passed}/${found.length} passed`,
      "",
      row(["Result", "Assertion", "Severity", "Message"]),
      row(["---", "---", "---", "---"]),
      ...found.map((assertion) =>
        row([
          assertion.passed ? "pass" : "FAIL",
          `\`${assertion.fqn}\``,
          assertion.severity,
          assertion.message,
        ])
      )
    );
  }
  return `${lines.join("\n")}\n`;
};

/** The built-in Markdown run summary. */
export const summary: Workflow.Report = make({
  name: "summary",
  render: (ctx) => Effect.sync(() => renderSummary(ctx)),
});

/** A stored, rendered report. */
export type Rendered =
  | { readonly format: Format; readonly content: string }
  | { readonly format: Format; readonly error: string };

/** The FQN a report of `workflow` is recorded at. */
export const fqnOf = (workflow: string, name: string) =>
  `${workflow}/report/${name}`;

/** A report's name from its record FQN; other names pass through. */
export const nameOf = (workflow: string, fqnOrName: string) =>
  fqnOrName.startsWith(fqnOf(workflow, ""))
    ? fqnOrName.slice(fqnOf(workflow, "").length)
    : fqnOrName;

/** The rendered report `name` (or its record FQN) of run `runId`. */
export const latest = (
  runId: string,
  name: string
): Effect.Effect<Rendered, ReportNotFound, State> =>
  Effect.gen(function* latestReport() {
    const state = yield* State;
    const run = yield* state.getRun(runId);
    const [record] =
      run === undefined
        ? []
        : yield* state.records({
            collection: run.collection,
            fqn: fqnOf(run.workflow, nameOf(run.workflow, name)),
            kind: "Report",
            limit: 1,
            runId,
          });
    if (record === undefined) {
      return yield* new ReportNotFound({
        message:
          run === undefined
            ? `Unknown run ${runId}`
            : `Run ${runId} has no report ${name}`,
        report: name,
        runId,
      });
    }
    return record.value as Rendered;
  });

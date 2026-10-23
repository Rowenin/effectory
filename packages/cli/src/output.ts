/**
 * Terminal output: the process exit code commands request, and the
 * human-readable renderings of runs, records, and resources.
 */
import type { Describe, Node, State } from "@effectory/core";
import { Console, Effect } from "effect";

let requested = 0;

/** Ask for a process exit code once the command finishes. */
export const setExitCode = (code: number) =>
  Effect.sync(() => {
    requested = code;
  });

/** The exit code the command asked for. */
export const exitCode = () => requested;

/** Print a value as indented JSON. */
export const printJson = (value: unknown) =>
  Console.log(JSON.stringify(value, null, 2));

const time = (epoch: number) => new Date(epoch).toISOString();

const compact = (value: unknown, width = 100) => {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > width ? `${text.slice(0, width - 3)}...` : text;
};

/** Lines padded into columns. */
export const table = (rows: readonly (readonly string[])[]): string => {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [index, cell] of row.entries()) {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    }
  }
  return rows
    .map((row) =>
      row
        .map((cell, index) =>
          index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)
        )
        .join("  ")
        .trimEnd()
    )
    .join("\n");
};

const nodeDetail = (node: Node.NodeRow) => {
  if (node.error !== undefined) {
    return `${node.error.tag}: ${node.error.message}`;
  }
  return node.reason ?? "";
};

/** One line per node: status, FQN, type, attempt, error or reason. */
export const renderNodes = (nodes: readonly Node.NodeRow[]): string =>
  table(
    nodes.map((node) => [
      `  ${node.status}`,
      node.fqn,
      `(${node.type})`,
      `#${node.attempt}`,
      nodeDetail(node),
    ])
  );

export const renderRunHeader = (run: State.RunRow): string => {
  const target = run.target === undefined ? "" : `, target ${run.target}`;
  return `Run ${run.id} of ${run.workflow} (scope ${run.scope}${target}, ${run.mode}): ${run.status}`;
};

export const renderRuns = (runs: readonly State.RunRow[]): string =>
  runs.length === 0
    ? "No runs."
    : table([
        ["ID", "WORKFLOW", "STATUS", "SCOPE", "CREATED"],
        ...runs.map((run) => [
          run.id,
          run.workflow,
          run.status,
          run.scope,
          time(run.createdAt),
        ]),
      ]);

export const renderApprovals = (
  approvals: readonly State.ApprovalRow[]
): string =>
  approvals.length === 0
    ? "No approvals."
    : table([
        ["ID", "STATUS", "TITLE"],
        ...approvals.map((approval) => [
          approval.id,
          approval.status,
          approval.title,
        ]),
      ]);

export const renderRecords = (records: readonly State.RecordRow[]): string =>
  records.length === 0
    ? "No records."
    : table([
        ["ID", "KIND", "FQN", "SCOPE", "RUN", "CREATED", "VALUE"],
        ...records.map((record) => [
          String(record.id),
          record.kind,
          record.fqn,
          record.scope,
          record.runId,
          time(record.createdAt),
          compact(record.value, 60),
        ]),
      ]);

export const renderResources = (
  resources: readonly State.ResourceRow[]
): string =>
  resources.length === 0
    ? "No resources."
    : table([
        ["FQN", "TYPE", "STATUS", "SCOPE", "LIFETIME", "ATTRIBUTES"],
        ...resources.map((resource) => [
          resource.fqn,
          resource.type,
          resource.status,
          resource.scope,
          resource.lifetime,
          compact(resource.attributes ?? null, 60),
        ]),
      ]);

const section = (title: string, lines: readonly string[]) =>
  lines.length === 0 ? [] : ["", `${title}:`, ...lines];

/** Human-readable `describe`. */
export const renderDescription = (described: Describe.Description): string => {
  const head = described.description
    ? `${described.name}: ${described.description}`
    : described.name;
  return [
    head,
    ...section(
      "Workflows",
      described.workflows.map(
        (workflow) => `  ${workflow.name}  ${workflow.description}`
      )
    ),
    ...section(
      "Actions",
      described.actions.map(
        (action) =>
          `  ${action.type}  ${action.description} (rerun: ${action.rerun}, retry: ${action.retry})`
      )
    ),
    ...section(
      "Resources",
      described.resources.map(
        (resource) => `  ${resource.type}  ${resource.description}`
      )
    ),
    ...section(
      "Targets",
      described.targets.map(
        (target) =>
          `  ${target.name} -> ${target.workflow} (v${target.version})  ${compact(target.input, 80)}`
      )
    ),
    ...section(
      "Triggers",
      described.triggers.map((trigger) => {
        const where =
          trigger.kind === "schedule"
            ? `cron ${trigger.cron}`
            : `POST ${trigger.route}`;
        return `  ${trigger.name}: ${where} -> ${trigger.target ?? trigger.workflow}`;
      })
    ),
    "",
    "Use --json for JSON Schemas of every input and output.",
  ].join("\n");
};

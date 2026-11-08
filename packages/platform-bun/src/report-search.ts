import type { Database } from "bun:sqlite";

import { OperationError } from "@effectory/runtime/protocol";
import {
  ReportSearchItem,
  ReportSearchRequest,
} from "@effectory/runtime/report-protocol";
import { RecordStatus } from "@offtree/effectory-sdk/internal/report-record";
import { Effect, Schema } from "effect";

import type { createPagination } from "./pagination.ts";

const parseJson = (text: string): unknown => JSON.parse(text);

const maximumWork = 10_000;
const batchWork = 500;
const maximumMetadata = 16_777_216;
const maximumResponse = 2_097_152;
// Includes worst-case JSON escaping of IDs, source identity, tags and path preview.
const maximumCandidate = 65_536;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const invalid = (message: string) =>
  new OperationError({ code: "InvalidInput", message });
const date = (value: string | undefined) => {
  if (value === undefined) {
    return null;
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw invalid("Search timestamps must be ISO dates");
  }
  return new Date(time).toISOString();
};
function normalize(value: typeof ReportSearchRequest.Type) {
  let input: typeof ReportSearchRequest.Type;
  try {
    input = Schema.decodeSync(ReportSearchRequest)(value, {
      onExcessProperty: "error",
    });
  } catch {
    throw invalid("Invalid report search filters");
  }
  if (input.taskId !== undefined && input.sourceWorkflowId !== undefined) {
    throw invalid("Choose task or source-workflow, not both");
  }
  const createdAfter = date(input.createdAfter);
  const createdBefore = date(input.createdBefore);
  if (
    createdAfter !== null &&
    createdBefore !== null &&
    Date.parse(createdAfter) > Date.parse(createdBefore)
  ) {
    throw invalid("Search created-after must not be later than created-before");
  }
  return {
    cursor: input.cursor,
    query: {
      attachmentId: input.attachmentId ?? null,
      createdAfter,
      createdBefore,
      history: input.history ?? false,
      limit: input.limit ?? 50,
      query: (input.query ?? "").toLowerCase(),
      reporterId: input.reporterId ?? null,
      runId: input.runId ?? null,
      scope: input.scope ?? null,
      ...(input.sourceWorkflowId === undefined
        ? {}
        : { sourceWorkflowId: input.sourceWorkflowId }),
      statuses: [
        ...new Set(
          input.statuses ??
            RecordStatus.literals.filter((status) => status !== "NotApplicable")
        ),
      ].toSorted(),
      tags: input.tags ?? {},
      taskId: input.taskId ?? null,
      workflowId: input.workflowId ?? null,
    },
  };
}
type Query = ReturnType<typeof normalize>["query"];
type Seek = (bound: number) => number | null;
const Sequence = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })
);
const Maximum = Schema.Struct({ value: Schema.NullOr(Sequence) });

function indexes(database: Database, principal: string, query: Query): Seek[] {
  const seeks: Seek[] = [];
  const add = (index: string, predicate: string, args: string[]) => {
    const statement =
      database.query(`SELECT MAX(sequence) value FROM host_report_search INDEXED BY ${index}
      WHERE principal=? ${predicate} AND sequence<=?`);
    seeks.push(
      (bound) =>
        Schema.decodeUnknownSync(Maximum)(
          statement.get(principal, ...args, bound)
        ).value
    );
  };
  if (query.runId !== null) {
    add("host_report_search_run", "AND sourceRunId=?", [query.runId]);
  }
  if (query.workflowId !== null) {
    add("host_report_search_root", "AND rootKind=? AND rootTargetId=?", [
      "workflow",
      query.workflowId,
    ]);
  }
  if (query.taskId !== null) {
    add(
      "host_report_search_source",
      "AND sourceTargetKind=? AND sourceTargetId=?",
      ["task", query.taskId]
    );
  }
  if (query.sourceWorkflowId !== undefined) {
    add(
      "host_report_search_source",
      "AND sourceTargetKind=? AND sourceTargetId=?",
      ["workflow", query.sourceWorkflowId]
    );
  }
  if (query.reporterId !== null) {
    add("host_report_search_reporter", "AND reporterId=?", [query.reporterId]);
  }
  if (query.attachmentId !== null) {
    add("host_report_search_attachment", "AND attachmentId=?", [
      query.attachmentId,
    ]);
  }
  for (const [key, value] of Object.entries(query.tags).toSorted(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const statement = database.query(
      "SELECT MAX(sequence) value FROM host_report_search_tags WHERE principal=? AND key=? AND value=? AND sequence<=?"
    );
    seeks.push(
      (bound) =>
        Schema.decodeUnknownSync(Maximum)(
          statement.get(principal, key, value, bound)
        ).value
    );
  }
  if (seeks.length === 0) {
    add("host_report_search_principal", "", []);
  }
  return seeks;
}

const Row = Schema.Struct({
  attachmentId: Schema.String,
  createdAt: Schema.String,
  generation: Schema.Int,
  groupId: Schema.String,
  notApplicableReason: ReportSearchItem.fields.notApplicableReason,
  pathText: Schema.NullOr(Schema.String),
  reportId: Schema.String,
  reportProviderId: Schema.NullOr(Schema.String),
  reportRunId: Schema.NullOr(Schema.String),
  reportRunStatus: ReportSearchItem.fields.reportRunStatus,
  reportTaskId: Schema.String,
  reportTaskVersion: Schema.Int,
  rootAcceptedAt: Schema.String,
  rootKind: ReportSearchItem.fields.root.fields.kind,
  rootTargetId: Schema.String,
  settledAt: Schema.NullOr(Schema.String),
  sourceJson: Schema.String,
  status: RecordStatus,
  tagsJson: Schema.String,
});
function projection(
  database: Database,
  query: Query,
  principal: string,
  snapshot: number
) {
  const statement =
    database.query(`SELECT q.attachmentId,r.createdAt,r.generation,r.groupId,
    r.notApplicableReason,r.reportId,r.reportRunId,r.settledAt,r.status,rr.status reportRunStatus,
    q.reporterId reportTaskId,
    json_extract(p.planJson,'$['||g.attachmentIndex||'].reporterVersion') reportTaskVersion,
    json_extract(p.planJson,'$['||g.attachmentIndex||'].reporterProviderId') reportProviderId,
    root.acceptedAt rootAcceptedAt,q.rootKind,q.rootTargetId,root.tagsJson,s.sourceJson,
    (SELECT substr(i.nodeId,1,2049) FROM host_invocations i WHERE i.engineId=s.invocationId AND i.runId=q.sourceRunId) pathText
    FROM host_report_search q JOIN host_reports r ON r.sequence=q.sequence
    JOIN host_report_groups g ON g.groupId=r.groupId
    JOIN host_report_sources s ON s.sourceId=g.sourceId
    JOIN host_report_plans p ON p.runId=q.sourceRunId
    JOIN host_runs root ON root.runId=q.sourceRunId
    LEFT JOIN host_runs rr ON rr.runId=r.reportRunId
    WHERE q.sequence=? AND q.principal=? AND (? IS NULL OR q.scope=?)
    AND r.status IN (${query.statuses.map(() => "?").join(",")})
    AND (? OR NOT EXISTS(SELECT 1 FROM host_reports n INDEXED BY host_reports_group_sequence
      WHERE n.groupId=r.groupId AND n.sequence>r.sequence AND n.sequence<=?))`);
  return (sequence: number) => {
    const raw = statement.get(
      sequence,
      principal,
      query.scope,
      query.scope,
      ...query.statuses,
      query.history ? 1 : 0,
      snapshot
    );
    if (raw === null) {
      return null;
    }
    const size = bytes(raw);
    if (size > maximumCandidate) {
      throw new OperationError({
        code: "LimitExceeded",
        message: "Report search metadata exceeds its per-record bound",
      });
    }
    const row = Schema.decodeUnknownSync(Row)(raw);
    const path = row.pathText === null ? null : [...row.pathText];
    const item = Schema.decodeUnknownSync(ReportSearchItem)({
      ...row,
      pathPreview:
        path === null
          ? null
          : {
              text: path.slice(0, 2048).join(""),
              truncated: path.length > 2048,
            },
      root: {
        acceptedAt: row.rootAcceptedAt,
        kind: row.rootKind,
        tags: parseJson(row.tagsJson),
        targetId: row.rootTargetId,
      },
      source: parseJson(row.sourceJson),
    });
    const created = Date.parse(item.createdAt);
    const matches =
      (query.createdAfter === null ||
        created >= Date.parse(query.createdAfter)) &&
      (query.createdBefore === null ||
        created <= Date.parse(query.createdBefore)) &&
      [
        item.attachmentId,
        item.reportTaskId,
        item.source.targetId,
        item.root.targetId,
      ].some((id) => id.toLowerCase().includes(query.query));
    return { item: matches ? item : null, size };
  };
}

/** Private diagnostics are only used by implementation proofs, never sent over RPC. */
interface BatchMetrics {
  readonly elapsedMillis: number;
  readonly units: number;
  readonly totalUnits: number;
  readonly metadataBytes: number;
}
export function reportSearch(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  value: typeof ReportSearchRequest.Type,
  principal: string,
  perform: <A>(body: () => A) => Effect.Effect<A, OperationError>,
  onBatch?: (metrics: BatchMetrics) => void
) {
  return Effect.gen(function* () {
    const state = yield* perform(() =>
      database.transaction(() => {
        const { query, cursor } = normalize(value);
        const scope = { kind: "report-search", principal, query };
        const token = pages.read(scope, cursor);
        const snapshot = token
          ? Schema.decodeUnknownSync(Sequence)(token.snapshot)
          : (Schema.decodeUnknownSync(Maximum)(
              database
                .query(
                  "SELECT MAX(sequence) value FROM host_report_search WHERE principal=?"
                )
                .get(principal)
            ).value ?? 0);
        const position = token
          ? Schema.decodeUnknownSync(Sequence)(token.position)
          : snapshot + 1;
        if (position > snapshot + 1) {
          throw invalid("Invalid search cursor position");
        }
        return {
          bound: position - 1,
          expires: token?.expires ?? Date.now() + 3_600_000,
          query,
          scope,
          snapshot,
        };
      })()
    );
    const { seeks, read } = yield* perform(() => ({
      read: projection(database, state.query, principal, state.snapshot),
      seeks: indexes(database, principal, state.query),
    }));
    const items: (typeof ReportSearchItem.Type)[] = [];
    let units = 0;
    let metadataBytes = 0;
    // Reserve envelope and the maximum 4 KiB signed cursor, including JSON overhead.
    let responseBytes = 8192;
    let index = 0;
    let agreed = 0;
    let finished = false;
    let scanLimited = false;
    let exhausted = state.bound < 1;
    const batch = perform(() =>
      database.transaction(() => {
        const before = units;
        const startedAt = performance.now();
        while (units - before < batchWork && !finished && !exhausted) {
          if (
            units >= maximumWork ||
            maximumMetadata - metadataBytes < maximumCandidate
          ) {
            scanLimited = true;
            finished = true;
            break;
          }
          if (agreed < seeks.length) {
            const seek = seeks[index];
            if (!seek) {
              throw new Error("Missing search index");
            }
            const found = seek(state.bound);
            units += 1;
            if (found === null) {
              exhausted = true;
              break;
            }
            if (found === state.bound) {
              agreed += 1;
            } else {
              state.bound = found;
              agreed = 1;
            }
            index = (index + 1) % seeks.length;
            continue;
          }
          const candidate = read(state.bound);
          units += 1;
          if (candidate !== null) {
            metadataBytes += candidate.size;
            if (candidate.item !== null) {
              const size = bytes(candidate.item) + 1;
              if (responseBytes + size > maximumResponse) {
                finished = true;
                break;
              }
              responseBytes += size;
              items.push(candidate.item);
            }
          }
          state.bound -= 1;
          agreed = 0;
          exhausted = state.bound < 1;
          if (items.length >= state.query.limit) {
            finished = true;
          }
        }
        return {
          elapsedMillis: performance.now() - startedAt,
          metadataBytes,
          totalUnits: units,
          units: units - before,
        };
      })()
    );
    while (true) {
      if (finished || exhausted) {
        break;
      }
      const metrics = yield* batch;
      onBatch?.(metrics);
      if (!finished && !exhausted) {
        yield* Effect.yieldNow;
      }
    }
    return {
      cursor: exhausted
        ? null
        : pages.write(
            state.scope,
            state.snapshot,
            state.bound + 1,
            state.expires
          ),
      items,
      scanLimited,
      snapshot: state.snapshot,
    };
  });
}

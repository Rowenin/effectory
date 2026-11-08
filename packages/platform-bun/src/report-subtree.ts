import type { Database } from "bun:sqlite";

import { OperationError } from "@effectory/runtime/protocol";
import type { PageRequest } from "@offtree/effectory-sdk/internal/report-history";
import {
  Event,
  EventRequest,
} from "@offtree/effectory-sdk/internal/report-history";
import { Effect, Schema } from "effect";

import { authorizeRun } from "./inspection.ts";
import type { createPagination } from "./pagination.ts";

type Perform = <A>(body: () => A) => Effect.Effect<A, OperationError>;
const Pointer = Schema.Struct({ bytes: Schema.Int, position: Schema.Int });
const limitError = (message: string) =>
  new OperationError({ code: "LimitExceeded", message });

/** Read at most one small batch synchronously. Never retain an iterator or transaction over a yield. */
export function subtreeScan(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  runId: string,
  principal: string,
  sourceId: string,
  path: string,
  kind: "events" | "invocations",
  input: typeof EventRequest.Type,
  perform: Perform
) {
  return Effect.gen(function* () {
    const state = yield* perform(() => {
      const { cursor, afterSequence, ...query } = Schema.decodeSync(
        EventRequest
      )(input, { onExcessProperty: "error" });
      authorizeRun(database, runId, principal);
      if (cursor !== undefined && afterSequence !== undefined) {
        throw new OperationError({
          code: "InvalidInput",
          message: "Specify cursor or afterSequence, not both",
        });
      }
      const limit = query.limit ?? 50;
      const scope = {
        kind: `report-subtree-${kind}`,
        principal,
        query: { limit, path, runId, sourceId },
      };
      const token = pages.read(scope, cursor);
      const snapshot = token
        ? Schema.decodeUnknownSync(Schema.Int)(token.snapshot)
        : Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Int }))(
            database
              .query(
                "SELECT COALESCE(MAX(position),0) value FROM host_report_paths WHERE runId=? AND kind=?"
              )
              .get(runId, kind)
          ).value;
      const after = token
        ? Schema.decodeUnknownSync(Schema.Int)(token.position)
        : (afterSequence ?? 0);
      if (after > snapshot) {
        throw new OperationError({
          code: "InvalidInput",
          message: "Sequence exceeds recorded history",
        });
      }
      return {
        after,
        cursor: (position: number) =>
          pages.write(
            scope,
            snapshot,
            position,
            token?.expires ?? Date.now() + 3_600_000
          ),
        limit,
        snapshot,
      };
    });
    const prefix = `${path.slice(0, -1)},`;
    const prefixLength = [...prefix].length;
    const positions: number[] = [];
    let position = state.after;
    let scanned = 0;
    let bytes = 0;
    let more = false;
    const started = performance.now();
    const batch = () =>
      database.transaction(() => {
        const rows = Schema.decodeUnknownSync(Schema.Array(Pointer))(
          database
            .query(
              "SELECT position,bytes FROM host_report_paths WHERE runId=? AND kind=? AND position>? AND position<=? ORDER BY position LIMIT 100"
            )
            .all(runId, kind, position, state.snapshot)
        );
        for (const row of rows) {
          if (
            scanned >= 10_000 ||
            bytes + row.bytes + 64 > 16_777_216 ||
            (scanned > 0 && performance.now() - started >= 250)
          ) {
            if (scanned === 0 && row.bytes + 64 > 16_777_216) {
              throw limitError(
                "Invocation attribution exceeds the history scan budget"
              );
            }
            more = true;
            return true;
          }
          scanned += 1;
          bytes += row.bytes + 64;
          const matched = database
            .query(
              "SELECT 1 FROM host_report_paths WHERE runId=? AND kind=? AND position=? AND (?='[]' OR diagnostic=1 OR path=? OR substr(path,1,?)=?)"
            )
            .get(runId, kind, row.position, path, path, prefixLength, prefix);
          ({ position } = row);
          if (matched !== null) {
            positions.push(position);
          }
          if (positions.length > state.limit) {
            more = true;
            return true;
          }
        }
        return rows.length < 100;
      })();
    while (position < state.snapshot) {
      if (scanned >= 10_000) {
        more = true;
        break;
      }
      const done = yield* perform(batch);
      if (done) {
        break;
      }
      yield* Effect.yieldNow;
    }
    return { ...state, more, position, positions };
  });
}

export function subtreeEvents(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  runId: string,
  principal: string,
  sourceId: string,
  path: string,
  request: typeof EventRequest.Type,
  perform: Perform
) {
  return Effect.gen(function* () {
    const page = yield* subtreeScan(
      database,
      pages,
      runId,
      principal,
      sourceId,
      path,
      "events",
      request,
      perform
    );
    return yield* perform(() => {
      const items: (typeof Event.Type)[] = [];
      let bytes = 0;
      let position = page.after;
      let { more } = page;
      for (const sequence of page.positions) {
        if (items.length >= page.limit) {
          more = true;
          break;
        }
        const bodyBytes = Schema.decodeUnknownSync(
          Schema.Struct({ bytes: Schema.Int })
        )(
          database
            .query(
              "SELECT length(CAST(payloadJson AS BLOB)) bytes FROM host_events WHERE runId=? AND sequence=?"
            )
            .get(runId, sequence)
        ).bytes;
        if (bodyBytes > 1_048_576) {
          if (items.length === 0) {
            throw limitError("Event exceeds page byte limit");
          }
          more = true;
          break;
        }
        const row = Schema.decodeUnknownSync(
          Schema.Struct({
            at: Schema.String,
            payloadJson: Schema.String,
            tag: Schema.String,
          })
        )(
          database
            .query(
              "SELECT at,payloadJson,tag FROM host_events WHERE runId=? AND sequence=?"
            )
            .get(runId, sequence)
        );
        const item = Event.make({
          at: row.at,
          payload: JSON.parse(row.payloadJson),
          runId,
          sequence,
          tag: row.tag,
        });
        const size = Buffer.byteLength(JSON.stringify(item));
        if (bytes + size > 1_048_576) {
          if (items.length === 0) {
            throw limitError("Event exceeds page byte limit");
          }
          more = true;
          break;
        }
        items.push(item);
        bytes += size;
        position = sequence;
      }
      if (items.length === page.positions.length) {
        ({ position } = page);
      }
      return {
        cursor: more ? page.cursor(position) : null,
        items,
        snapshot: page.snapshot,
      };
    });
  });
}

export function subtreeInvocations(
  database: Database,
  pages: ReturnType<typeof createPagination>,
  runId: string,
  principal: string,
  sourceId: string,
  path: string,
  request: PageRequest,
  perform: Perform
) {
  return Effect.gen(function* () {
    const page = yield* subtreeScan(
      database,
      pages,
      runId,
      principal,
      sourceId,
      path,
      "invocations",
      request,
      perform
    );
    const rows = yield* perform(() =>
      page.positions.map((position) =>
        Schema.decodeUnknownSync(
          Schema.Struct({
            attemptCount: Schema.Int,
            engineId: Schema.String,
            pathText: Schema.String,
            position: Schema.Int,
            taskId: Schema.String,
          })
        )(
          database
            .query(
              "SELECT i.rowid position,i.engineId,substr(i.nodeId,1,2049) pathText,json_extract(i.payloadJson,'$.taskId') taskId,(SELECT COUNT(*) FROM host_attempts a WHERE a.runId=i.runId AND a.nodeId=i.nodeId) attemptCount FROM host_invocations i WHERE runId=? AND rowid=?"
            )
            .get(runId, position)
        )
      )
    );
    return { ...page, rows };
  });
}

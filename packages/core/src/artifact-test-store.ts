/* oxlint-disable unicorn/consistent-function-scoping -- Error constructors are colocated with the private fixture store. */
import { Effect, Schema, Stream } from "effect";

import {
  captureFixture,
  digestContent,
  fixtureData,
  invalidFixture,
} from "./artifact-fixture.ts";
import type {
  Fixture,
  FixtureData,
  FixtureOptions,
} from "./artifact-fixture.ts";
import {
  FieldDescriptions,
  makeQueryEvaluator,
} from "./artifact-query-evaluator.ts";
import { Query } from "./artifact-query-schema.ts";
import { readFailure } from "./artifact-read-errors.ts";
import {
  checkReference,
  referenceFor,
  readerRuntime,
} from "./artifact-reader-runtime.ts";
import type { ReaderBackend } from "./artifact-reader-runtime.ts";
import type { Metadata } from "./artifact-reader.ts";
import type * as Artifact from "./artifact.ts";
import { binaryOwner, binaryPool } from "./binary-admission.ts";
import { canonical } from "./boundary.ts";

interface Stored {
  fixture: Fixture;
  data: FixtureData;
  record: Metadata;
  fields: Record<string, Schema.Json>;
}
const byteLength = (content: string | Uint8Array) =>
  typeof content === "string"
    ? new TextEncoder().encode(content).length
    : content.length;
const logicalIdentity = (options: FixtureOptions) =>
  canonical([
    options.taskId ?? "fixture",
    options.output ?? "value",
    options.key ?? "",
  ]);
export function artifactTestStore(seeds: readonly Fixture[] = []) {
  const rows: Stored[] = [];
  const identities = new Map<string, string>();
  const ids = new Map<string, string>();
  const aliases = new Map<string, string>();
  const catalog = new Map<string, string>();
  let maximumTime: number | undefined;
  let nextDigest = 0;
  let nextId = 0;
  const collision = () =>
    invalidFixture(
      "Conflicting artifact fixtures: use distinct keys or increasing versions; seed the next producer with the previous result's artifacts instead of merging independent test results"
    );
  // oxlint-disable-next-line complexity -- Validate the complete identity, alias and version tuple before appending any row.
  const add = (fixture: Fixture) => {
    const source = fixtureData(fixture);
    if (!source) {
      throw invalidFixture();
    }
    const data = fixtureData(captureFixture(source));
    if (!data) {
      throw invalidFixture();
    }
    const { reference: ref, options, artifact } = data;
    const identity = logicalIdentity(options);
    if (
      (identities.has(identity) &&
        identities.get(identity) !== ref.artifactId) ||
      (ids.has(ref.artifactId) && ids.get(ref.artifactId) !== identity)
    ) {
      throw collision();
    }
    const duplicate = rows.find(
      (row) =>
        row.record.artifactId === ref.artifactId &&
        row.record.version === ref.version
    );
    if (duplicate) {
      if (
        canonical(duplicate.data.reference) !== canonical(ref) ||
        duplicate.data.digest !== data.digest ||
        canonical({ ...duplicate.data.options }) !== canonical({ ...options })
      ) {
        throw collision();
      }
      return duplicate;
    }
    const previous = rows.findLast(
      (item) => item.record.artifactId === ref.artifactId
    );
    if (previous && previous.record.version >= ref.version) {
      throw collision();
    }
    const committedAt =
      options.committedAt ?? new Date((maximumTime ?? 0) + 1).toISOString();
    const time = new Date(committedAt).getTime();
    if (
      !Number.isFinite(time) ||
      new Date(time).toISOString() !== committedAt ||
      (previous && time < new Date(previous.record.committedAt).getTime())
    ) {
      throw invalidFixture("Fixture version timestamps must not run backwards");
    }
    if (/^test-digest-[1-9][0-9]*$/u.test(ref.digest)) {
      if (aliases.has(ref.digest) && aliases.get(ref.digest) !== data.digest) {
        throw collision();
      }
      aliases.set(ref.digest, data.digest);
      nextDigest = Math.max(nextDigest, Number(ref.digest.slice(12)));
    } else if (ref.digest !== data.digest) {
      throw collision();
    }
    if (/^test-artifact-[1-9][0-9]*$/u.test(ref.artifactId)) {
      nextId = Math.max(nextId, Number(ref.artifactId.slice(14)));
    }
    const schemaKey = canonical([artifact.id, artifact.version]);
    const descriptions =
      artifact.kind === "bytes"
        ? []
        : artifact.queryFields.map(({ path, types }) => ({ path, types }));
    const schema = canonical({
      contentType: artifact.contentType,
      descriptions,
      kind: artifact.kind,
    });
    if (catalog.has(schemaKey) && catalog.get(schemaKey) !== schema) {
      throw invalidFixture(
        "Artifact kind, content type or query fields changed without a schema version change"
      );
    }
    catalog.set(schemaKey, schema);
    identities.set(identity, ref.artifactId);
    ids.set(ref.artifactId, identity);
    maximumTime =
      maximumTime === undefined ? time : Math.max(maximumTime, time);
    const fields: Record<string, Schema.Json> = {};
    if (artifact.kind === "json" && typeof data.content === "string") {
      const value: unknown = JSON.parse(data.content);
      for (const field of artifact.fields) {
        let current: unknown = value;
        for (const key of field) {
          current =
            typeof current === "object" &&
            current !== null &&
            Object.hasOwn(current, key)
              ? Reflect.get(current, key)
              : undefined;
        }
        if (current !== undefined) {
          fields[JSON.stringify(field)] = Schema.decodeUnknownSync(Schema.Json)(
            current
          );
        }
      }
    }
    const stored: Stored = {
      data,
      fields,
      fixture: captureFixture(data),
      record: {
        ...ref,
        attemptId: options.attemptId ?? "fixture-attempt",
        bytes: byteLength(data.content),
        committedAt,
        contentType: artifact.contentType,
        invocationPath: options.invocationPath ?? "task",
        kind: artifact.kind,
        output: options.output,
        revision: options.revision ?? "fixture-revision",
        runId: options.runId ?? "fixture-run",
        sequence: rows.length + 1,
        tags: { ...options.tags },
        taskId: options.taskId,
      },
    };
    rows.push(stored);
    return stored;
  };
  for (const seed of seeds) {
    add(seed);
  }
  const find = (ref: Artifact.Reference) => {
    const row = rows.find(
      (item) =>
        item.record.artifactId === ref.artifactId &&
        item.record.version === ref.version
    );
    if (!row) {
      throw readFailure("NotFound", ref, true);
    }
    return row;
  };
  const evaluate = makeQueryEvaluator(() => readFailure("InvalidQuery"));
  const cursors = new Map<
    string,
    { query: string; snapshot: number; position: number; expires: number }
  >();
  const safe = <A>(body: () => A) =>
    Effect.try({
      catch: (error) =>
        error instanceof Error && "reason" in error
          ? (error as ReturnType<typeof readFailure>)
          : readFailure("Corrupt"),
      try: body,
    });
  const backend: ReaderBackend = {
    json: (record) =>
      safe(() => {
        const row = find(record);
        if (typeof row.data.content !== "string") {
          throw readFailure("KindMismatch", record, true);
        }
        return Schema.decodeUnknownSync(Schema.Json)(
          JSON.parse(row.data.content)
        );
      }),
    latest: (artifact, identity) =>
      safe(() => {
        const id = identities.get(logicalIdentity(identity));
        const row = rows.findLast((item) => item.record.artifactId === id);
        if (!row) {
          throw readFailure("NotFound");
        }
        const ref = referenceFor(row.record);
        checkReference(artifact, ref, row.record, true);
        return ref;
      }),
    query: (artifact, options) =>
      // oxlint-disable-next-line complexity -- Validate, page and project one immutable query snapshot.
      safe(() => {
        let query: Query;
        const { cursor, ...rest } = options;
        try {
          query = Schema.decodeUnknownSync(Query)(
            {
              ...rest,
              artifact: {
                schemaId: artifact.id,
                schemaVersion: artifact.version,
              },
              limit: options.limit ?? 50,
              version: 1,
            },
            { onExcessProperty: "error" }
          );
        } catch {
          throw readFailure("InvalidQuery");
        }
        const fingerprint = canonical(
          Schema.decodeUnknownSync(Schema.Json)(query)
        );
        const token = cursor === undefined ? undefined : cursors.get(cursor);
        if (token && token.expires <= Date.now()) {
          throw readFailure("CursorExpired");
        }
        if (cursor !== undefined && (!token || token.query !== fingerprint)) {
          throw readFailure("InvalidCursor");
        }
        const snapshot = token?.snapshot ?? rows.length;
        const schemaKey = canonical([artifact.id, artifact.version]);
        const schemaDescription = catalog.get(schemaKey);
        const descriptions =
          schemaDescription === undefined
            ? []
            : Schema.decodeUnknownSync(FieldDescriptions)(
                JSON.parse(schemaDescription).descriptions
              );
        evaluate.validate(query, descriptions);
        const snapshotRows = rows.filter(
          (row) => row.record.sequence <= snapshot
        );
        const latest = new Map(
          snapshotRows.map((row) => [row.record.artifactId, row])
        );
        const selected = snapshotRows.filter(
          (row) =>
            row.record.schemaId === artifact.id &&
            row.record.schemaVersion === artifact.version &&
            (query.versions === "all" ||
              latest.get(row.record.artifactId) === row)
        );
        const scannedBytes = selected.reduce(
          (total, row) =>
            total +
            new TextEncoder().encode(
              canonical(Schema.decodeUnknownSync(Schema.Json)(row.record))
            ).length +
            new TextEncoder().encode(canonical(row.fields)).length,
          0
        );
        if (selected.length > 10_000 || scannedBytes > 16_777_216) {
          throw readFailure("QueryBudget");
        }
        const matches = selected
          .filter((row) => !query.where || evaluate.matches(query.where, row))
          .toSorted((a, b) => evaluate.order(query, a, b));
        const offset = token?.position ?? 0;
        const page = [];
        let bytes = 0;
        for (const row of matches.slice(offset, offset + query.limit)) {
          const projected = evaluate.project(query, row);
          bytes += new TextEncoder().encode(canonical(projected)).length;
          if (bytes > 2_097_152) {
            if (page.length === 0) {
              throw readFailure("QueryBudget");
            }
            break;
          }
          page.push({
            metadata: { ...row.record, tags: { ...row.record.tags } },
            ref: referenceFor(row.record),
            ...(projected.projection === undefined
              ? {}
              : { projection: projected.projection }),
          });
        }
        let next: string | null = null;
        if (offset + page.length < matches.length) {
          next = crypto.randomUUID();
          cursors.set(next, {
            expires: token?.expires ?? Date.now() + 3_600_000,
            position: offset + page.length,
            query: fingerprint,
            snapshot,
          });
        }
        return {
          cursor: next,
          matched: matches.length,
          rows: page,
          scanned: selected.length,
          scannedBytes,
          snapshot,
        };
      }),
    resolve: (artifact, ref) =>
      safe(() => {
        const row = find(ref);
        checkReference(artifact, ref, row.record, true);
        return { ...row.record, tags: { ...row.record.tags } };
      }),
    stream: (record) =>
      Stream.unwrap(
        safe(() => {
          const row = find(record);
          if (typeof row.data.content === "string") {
            throw readFailure("KindMismatch", record, true);
          }
          const { content } = row.data;
          return Stream.fromIterable(
            Array.from(
              { length: Math.ceil(content.length / 65_536) },
              (_, index) =>
                new Uint8Array(
                  content.subarray(index * 65_536, (index + 1) * 65_536)
                )
            )
          );
        })
      ),
  };
  const binding = readerRuntime(backend, binaryOwner(binaryPool()));
  return {
    artifacts: () => Object.freeze(rows.map((row) => row.fixture)),
    binding,
    publish: (
      artifact: Artifact.Any,
      content: string | Uint8Array,
      options: FixtureOptions & { taskId: string; output: string; key: string }
    ) =>
      Effect.gen(function* () {
        const digest = yield* digestContent(
          typeof content === "string"
            ? new TextEncoder().encode(content)
            : content
        );
        return yield* Effect.try({
          catch: () => collision(),
          try: () => {
            const identity = logicalIdentity(options);
            let artifactId = identities.get(identity);
            if (artifactId === undefined) {
              nextId += 1;
              artifactId = `test-artifact-${nextId}`;
            }
            const previous = rows.findLast(
              (item) => item.record.artifactId === artifactId
            );
            nextDigest += 1;
            const ref = {
              artifactId,
              digest: `test-digest-${nextDigest}`,
              schemaId: artifact.id,
              schemaVersion: artifact.version,
              version: (previous?.record.version ?? 0) + 1,
            };
            add(
              captureFixture({
                artifact,
                content,
                digest,
                options,
                reference: ref,
              })
            );
            return ref;
          },
        });
      }),
  };
}

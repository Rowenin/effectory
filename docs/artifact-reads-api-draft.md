# Artifact reads — approved API contract

Status: **User-approved, implemented and verified**, 2026-11-06. Approval includes the six reader methods, first-access retention (1,024 external versions per run), pending-report protection, test fixtures, and shared binary read/write scheduling. Both round-4 reviews and their corrections are incorporated. See [implementation evidence](artifact-reads-implementation.md) for the passing checks and practical limits.

## Purpose and Swamp mapping

Tasks and reporters can read previously published artifacts through an injected Effect service. This covers typed JSON, streamed or fully verified bytes, exact references, latest-by-publication-identity lookup and queries. It preserves ordinary Effect error handling, Layer substitution and Stream composition.

Swamp's `readResource` and `readModelData` address data by configured model/name. Effectory instead addresses a publication by producer task ID, output name and key, or by its exact reference. Its query reuses the existing Schema-defined lake AST. Configured model instances, rename recovery, namespaces, CEL, SQL/DuckDB and automatic vault-reference rehydration remain gaps, not implied parity. The source comparisons are recorded in the research and reviews.

## Authoring surface

Add `ArtifactReader`, a normal Context.Service exported directly from the SDK root and the `./ArtifactReader` subpath, alongside `ArtifactStorage`. Existing publication APIs and publish-only fakes stay intact. The host supplies the reader per invocation, including task-local Layer acquisition. Standalone Effects retain the `ArtifactReader` requirement; task definitions remove it from their exposed requirements as they do ArtifactStorage and Report.History.

Export the two Schema.TaggedError classes `ArtifactReadError` and `ArtifactUnavailable` from the root and reader subpath. Move the existing lake query schemas to the `ArtifactQuery` namespace/subpath in core; runtime re-exports the same schema objects. Wire request syntax stays unchanged.

Proposed signatures below are a contract sketch, not implemented or typechecked SDK declarations:

```ts
type ReadError = ArtifactReadError | ArtifactUnavailable;

interface Identity {
  readonly taskId: string;
  readonly output: string;
  readonly key: string;
}

interface Metadata extends ArtifactQuery.Record {
  readonly kind: "json" | "bytes";
  readonly contentType: string;
}

interface Row<A extends Artifact.Any> {
  readonly ref: A["refSchema"]["Type"];
  readonly metadata: Metadata;
  readonly projection?: Readonly<Record<string, Schema.Json>>;
}

interface QueryOptions {
  readonly versions: "all" | "latest";
  readonly limit?: number;
  readonly where?: ArtifactQuery.Expression;
  readonly orderBy?: ArtifactQuery.Query["orderBy"];
  readonly select?: ArtifactQuery.Query["select"];
  readonly cursor?: string;
}

interface Page<A extends Artifact.Any> {
  readonly rows: readonly Row<A>[];
  readonly cursor: string | null;
  readonly snapshot: number;
  readonly matched: number;
  readonly scanned: number;
  readonly scannedBytes: number;
}

interface Service {
  readonly get: <A extends Artifact.Artifact>(
    artifact: A,
    ref: NoInfer<A["refSchema"]["Type"]>
  ) => Effect.Effect<A["schema"]["Type"], ReadError>;

  readonly stream: <A extends Artifact.Bytes>(
    artifact: A,
    ref: NoInfer<A["refSchema"]["Type"]>
  ) => Stream.Stream<Uint8Array, ReadError>;

  readonly bytes: <A extends Artifact.Bytes>(
    artifact: A,
    ref: NoInfer<A["refSchema"]["Type"]>
  ) => Effect.Effect<Uint8Array, ReadError>;

  readonly metadata: <A extends Artifact.Any>(
    artifact: A,
    ref: NoInfer<A["refSchema"]["Type"]>
  ) => Effect.Effect<Metadata, ReadError>;

  readonly latest: <A extends Artifact.Any>(
    artifact: A,
    identity: Identity
  ) => Effect.Effect<A["refSchema"]["Type"], ReadError>;

  readonly query: <A extends Artifact.Any>(
    artifact: A,
    options: QueryOptions
  ) => Effect.Effect<Page<A>, ReadError>;
}
```

`ArtifactQuery.stream(artifact, options)` is a plain helper returning `Stream<Row<A>, ReadError, ArtifactReader>`. Its options omit the cursor and reject a supplied cursor. It pages through `reader.query` using Effect Stream, has no automatic restart, and adds no method to fakes.

There is no optional-read helper. A caller can handle the `NotFound` or `Reclaimed` reason explicitly without folding corruption into absence.

### Exact reads and identity

- Every operation is lazy. `get` returns a value decoded with the supplied definition; `stream` and `bytes` accept only bytes definitions. `metadata` checks and acquires the exact reference without reading its content. Metadata success does not prove blob integrity or codec compatibility.
- Verify authorized stored metadata against all reference fields, definition ID/version, kind and content type before exposing content. Distinguish a wrong reference digest from corrupt stored bytes. Another principal's version is indistinguishable from missing data. A read needs no output declaration.
- Equivalent definition objects are allowed. No identity-based output-membership test or schema migration is implied. A v1 reference with a v2 definition fails at runtime; the existing reference schema's numeric schemaVersion does not reject this at compile time.
- `latest` selects the newest retained version of exactly `(principal, taskId, output, key)`, then checks it against the supplied definition. It does not fall back to an older matching schema if the newest version uses another schema. Reclaimed newest versions are ignored, as in current latest queries.
- A V1-bound latest query omits identities whose newest retained version uses V2, whereas `latest(V1, identity)` fails SchemaMismatch for that identity. The mismatch includes the matched stored artifactId/version, so the consumer can deliberately choose another definition. There is no automatic migration.
- All identity components are explicit, including taskId. A consumer uses `Collect.id`; there is no implicit current-task default. Output and key use existing identifier validation. Task ID changes create a different identity; old task IDs can still be supplied. The hash representation stays internal.
- No new queryable `key` metadata field is needed for this slice: `latest` supplies the identity lookup. If bulk key matching becomes necessary it is a separate additive query decision.

### Errors and decoding

`ArtifactUnavailable` has `reason: "Busy" | "Storage"` and a fixed safe message. It describes transient storage failures, including SQLite contention after bounded retries. Ordinary binary capacity queues rather than failing Busy. `ArtifactReadError` has a fixed safe message, nullable artifactId/version, and one of:

`NotFound`, `Reclaimed`, `KindMismatch`, `SchemaMismatch`, `DigestMismatch`, `DecodeFailed`, `Corrupt`, `InvalidQuery`, `InvalidCursor`, `CursorExpired`, `QueryBudget`, `PinLimit`, `ConcurrencyLimit`, `Closed`, `Unsupported`.

Messages never contain raw content, query values, Schema issue text or codec defect messages. Do not log discarded codec errors through the task logger either: a secret in another run's artifact may not be tracked by this attempt's vault guard.

An error's artifactId is populated only from an authorized matched record, a canonical lowercase 64-hex ID, or a valid synthetic harness alias. Arbitrary caller strings become null. Version is either a matched/stated positive safe integer or null. This restriction applies to structured error fields, not just messages.

Keep the existing explicit task error contract. Authors put `Schema.Union([ArtifactReadError, ArtifactUnavailable])` in `error`, handle them, or explicitly use `Effect.orDie`. Do not implicitly add reader errors to every Task handler or silently route them to host failures. A declared `ArtifactUnavailable` supports existing `retry.when`; permanent reasons do not share its tag. A task-local Layer's declared reader errors must remain typed through taskLayer, as other declared domain errors do.

Decode JSON after content verification and outside all SQLite transactions, using `Effect.suspend` around `Schema.decodeUnknownEffect` with excess properties rejected. Async service-free codecs are supported on reads. Run decoding in a lifetime-owned child and observe its Exit with Fiber.await, never Fiber.join. Success returns the value; Schema failure, defect or codec self-interruption becomes safe DecodeFailed, or Closed if the invocation has closed. External interruption interrupts and awaits cleanup of that child, discards its complete Exit, and leaves the caller cleanly interrupted. This prevents a codec finalizer's defect text from accumulating in the reader's cause during interruption. Any reader body executing author code follows this isolation rule rather than publicationLifetime.run's join path.

User codec logging and arbitrary side effects remain trusted author code. Do not claim a size bound can preempt a synchronous infinite loop. Async/cooperative decoding runs under the task's existing timeout; no new decode timer is introduced. Publishing's synchronous encoding rule is unchanged.

Adapter mappings are explicit, without parsing error-message strings:

| Existing condition | Reader outcome |
| --- | --- |
| Query InvalidInput, malformed AST, excessive terms/depth | InvalidQuery |
| Malformed cursor or cursor bound to another query/limit/principal | InvalidCursor |
| Expired cursor or reclamation epoch change | CursorExpired |
| QueryBudgetExceeded, oversized projected row/page or cursor | QueryBudget |
| Fenced/closed/unadmitted invocation | Closed |
| latest finds only tombstones | Reclaimed |
| latest finds no identity, or a foreign principal's identity | NotFound |
| Retained blob missing, corrupt bytes/length/digest, invalid stored JSON | Corrupt |
| SQLite contention after the bounded internal retry | ArtifactUnavailable/Busy |
| Other transient storage I/O failure | ArtifactUnavailable/Storage |

Use stored tombstone/metadata state to distinguish missing from reclaimed; preserve the existing CLI OperationError behavior. Legacy metadata without kind/contentType defaults to `json` and `application/json`. Closed is a reader-domain error, while the existing publication API keeps TaskRuntimeError/InvalidBoundary.

### Streams and ownership

- `stream` verifies size and digest while consuming. Corruption can be reported after chunks have reached downstream code. Stopping early closes the reader but does not verify the whole artifact.
- `bytes` consumes and verifies the whole artifact before returning a fresh Uint8Array, capped at the existing 16 MiB limit. It is for consumers that must not act on unverified chunks. JSON remains capped at 1 MiB.
- The invocation owns in-flight reads and descriptor scopes. Acquisition, streaming and asynchronous decoding stop when the caller is interrupted or the invocation closes. A stream constructed while open cannot start or continue after close. Close awaits cleanup before task-local Layers release their resources. No cross-fiber descriptor close/reuse race is allowed.
- A pump can report normal end-of-stream only after EOF length/digest verification. Invocation close fails any still-consuming stream with Closed, never a short success or a queue shutdown masquerading as caller interruption. Descriptor/content errors fail with their mapped typed error. Early interruption by the consumer still interrupts its pump and awaits cleanup.
- Reads work during Layer acquisition and the handler, including handler cleanup before it exits. Layer finalizers and saved services after invocation close fail `Closed`. A fresh Layer memo map per attempt preserves isolation.
- JSON get takes no binary content slot: its authorized raw file read, length and digest verification are one synchronous, non-yielding step of at most 1 MiB. Decoding runs afterward in the isolated child. Metadata, latest and query also take no slot. This is tied to the current synchronous implementation, not permission to make JSON I/O asynchronous without revisiting its resource bounds.
- Proposed shared binary admission: at most four invocations can perform binary reads or publications concurrently. A first stream/bytes read or bytes publication queues for that invocation slot; overlapping operations in the same invocation share it. JSON publication is unchanged. CLI download permits remain separate. This is a deliberate amendment to existing binary publication scheduling and needs user approval.
- Always acquire the shared invocation slot **before** the existing binary writer permit. A bytes publication keeps the shared slot while waiting for and holding its writer permit, including source-stream consumption. The host publishBytes bridge holds this publication reference around the entire existing binary publish call: writer wait, source consumption, installation retries and writer release. It releases the reference only after the writer permit. The invocation-slot pool is one daemon-wide instance; one owner created with each attempt runtime context is shared by the reader and publishBytes bridges. A reader pulled by that source reuses the invocation's slot; a publication started while reading also reuses it, then waits for a writer. The four-writer limit stays unchanged. This removes the demonstrated reader/writer inversion without adding a new publication error or making the normal `publish(Def, reader.stream(...))` copy fail Busy under saturation. Both bridges must share the exact same private per-invocation admission owner; independently constructed pools would invalidate the order.
- Each admitted invocation has at most four live binary reads. JSON get does not count. An extra local read waits interruptibly while at least one reserved operation is a finite bytes read or is awaiting admission. If all four are open streams, fail permanent ConcurrencyLimit instead of waiting on a potentially self-dependent consumer. Re-evaluate that condition when admission completes or another read changes state, so an already-queued read cannot remain stuck behind four newly opened streams. An interrupted local waiter is removed from the queue; a read position granted concurrently with interruption is passed to the next waiter or released exactly once. A bytes publication's source reads count toward the local read limit. Local waiters are served before returning an otherwise idle invocation slot. This adopts consumer K3: parallel finite reads throttle, while authors keeping several streams open must respect the bound. Publications do not consume these four read positions; they remain limited by the separate four-writer pool.
- Invocation slots use a dedicated FIFO hand-off queue: release grants directly to the oldest waiter, and a grant racing cancellation is returned or passed on. A bare Effect Semaphore does not promise this ordering. The pending acquisition belongs to the invocation, not the first caller. Interrupting one caller does not cancel its siblings' shared wait; withdraw the request when no pending operation needs it. An invocation that has become idle re-enters at the tail for its next operation.
- Internally use Idle/Pending/Held/Closed states, with reference counts covering publications and reserved binary reads, and a separate local-read queue. State changes and last-release/new-acquire handoff are synchronous. The acquisition wait must be interruptible: do not put it inside an uninterruptible acquireRelease acquisition. Mask only state/finalizer installation; an invocation-owned acquirer forked from that region must explicitly restore interruptibility around its wait. On invocation close, in order: mark the owner Closed; fail pending reads with Closed and pending publications with the existing TaskRuntimeError/InvalidBoundary (publications gain no reader-domain error); interrupt and await owned reads and publications including descriptor and staging cleanup; only then return a still-held invocation slot, exactly once. Finalizers running after close are no-ops. This close runs within the same invocation close as the publication lifetime, before task-local Layers release, rather than in the host's later active-state cleanup.
- For exact reads, authorize and acquire the durable pin (including bounded contention retries) before reserving binary capacity, then re-check invocation liveness before opening content. No read slot is held through pin-retry sleeps. A read nested within a publication can still inherit that publication's writer/shared-slot ownership; its retry remains bounded and is not an additional admission acquisition. No content slot is acquired before execution/report worker admission.
- Queue time counts toward the attempt deadline. Four long-lived binary invocations can delay all later binary reads **and writes** until release or timeout. Slots are retained while operations overlap, not rotated per operation; streams are not preempted. The cap allows 16 simultaneous reads and up to 256 MiB of whole-byte payload buffers, before temporary copies, writer buffers and caller-retained results. This is not a process-memory guarantee. Existing publish-only tasks are affected without code changes: long-lived readers can delay them or exhaust their attempt deadline, and sequential publish loops re-enter the invocation queue per publication while saturated. An admitted invocation keeps its slot while waiting for a writer; the existing writer semaphore can still permit barging among admitted invocations. FIFO applies to invocation admission, not to each writer operation. Arbitrary user stream dependency cycles, including recursively waiting for publication while all writers are occupied, are not solved by pool ordering.
- Task.test mirrors local binary-read behavior and lifetime rules and bounds its own bytes publications to four concurrent writers, so copy-source opening matches production. It has no competing invocations or daemon-wide admission queue. It cannot prove production admission fairness or saturation timeouts. Those need real-host tests.
- An ordinary inner `Task.provide(Layer.succeed(ArtifactReader, fake))` overrides the host default. An application-level fake is overridden by the invocation default. Fakes themselves do not automatically gain host lifetime/pin checks. Application exports still use `satisfies Application.Application<...>` with their actual remaining host requirements, and reader-using Layers belong on tasks.

## Queries, snapshots and scale

Reuse Eq/Gt/Gte/Lt/Lte/In/And/Or/Not, existing fields, ordering and projections. Definition binds schema ID/version. Require `versions`; default limit to 50, maximum 200. JSON-field and comparison validation remains at runtime. Page rows expose an exact ref ready for get/metadata/stream.

Rows contain task/output metadata but do not expose the publication key. `scanned` and `scannedBytes` are planner diagnostics and may change after internal optimization, not stable semantic counts.

Latest means latest retained version per identity at the snapshot, **before** applying the predicate. A fresh query is live, including on a task retry. A continuation keeps the original snapshot for up to one hour. Its query, principal and page limit must match. Reclamation anywhere under that principal expires the cursor. Neither query nor ArtifactQuery.stream automatically restarts or silently skips an invalid page.

Query results are metadata and do not pin content. A version can be reclaimed between query and get. To preserve a selected external reference for later graph steps, acquire it with metadata in the selecting task before returning it; merely returning a query row is insufficient. The task result then provides the existing durable boundary. `latest` resolves and acquires in one operation.

Preserve existing 10,000-row, 16 MiB scanned-metadata, 250 ms and 2 MiB page budgets, but narrow indexed candidates before charging them. At minimum, an exact runId, artifactId or taskId filter, including inside a conjunction, must not scan unrelated identities of the same schema. Tag equality conjunctions also need SQL candidate filtering, following run-tag history precedent. Arbitrary broad or unsupported-for-pushdown predicates may still exceed the budget. No promise of arbitrary lake-scale analytics is made.

Pushdown must preserve missing/null semantics, negation, compound predicates, latest-before-filter ranking and snapshot membership. Keep one shared pure evaluator/validator/order/project implementation for the host and fixtures. Do not implement a weaker test query language. The existing wire AST is unchanged; improve candidate selection internally. Tests must demonstrate a report's exact-source query with 100,000 unrelated rows, plus semantic equivalence across pushed and non-pushed predicates. The 250 ms budget remains load-dependent and fails explicitly rather than returning a partial successful result.

Only necessary positive equalities with non-null scalar values may narrow candidates, at the root or under conjunctions. Do not push through Or/Not or into the latest-version subquery. Always re-evaluate the full predicate. Literal tag keys must not become unescaped JSON paths. The internal query optimization uses a retained-tag side table, transactional maintenance and atomic backfill, plus run/task expression indexes. It conservatively leaves unsupported text cases on the existing evaluator path. Query-schema extraction must retain the existing CLI error codes/messages; core evaluation failures are mapped by each adapter.

## Durable consumption and retention amendment

This retention amendment was included in the user approval on 2026-11-06.

1. **Same run:** publications remain protected by their unfinished producer run. Graph branches and child workflows share that root run. Reading them requires no extra pin. Reporters reading their own source run's publications are also exempt from pins and the cap while their report protection holds. Verify that relationship from stored report provenance/status in the same transaction; callers cannot claim it through input. Otherwise treat the read as an ordinary external read: it pins and counts.
2. **Other runs:** successful authorized reference resolution by get, metadata, stream open, bytes or latest records a consumer dependency before returning metadata/content or running a consumer codec. It survives retries, waits, NeedsAttention and process death until the consumer run is terminal. A later decode/content failure does not roll it back; conservative retention lasts to terminal status.
3. **Before first access:** a reference in submitted input, schedule input or a query result is not protected automatically. Do not scan JSON or walk input schemas at admission. A task can call metadata first, but there is no guarantee between run admission and that call. Surface `Reclaimed` honestly. Both round-2 reviewers now accept this first-access boundary; the consumer reviewer withdrew the earlier admission-pin recommendation.
4. **Bounds:** 1,024 distinct external versions per consumer run, idempotent for repeats. Same-run reads do not consume it. At the cap, acquiring another external version fails permanent PinLimit before exposing content; existing pins remain readable. Terminal pins cease protecting immediately and are cleaned up in bounded batches. Missing consumer state is conservatively protected. Do not claim a fixed total-row bound from the active-run limit, because attention runs and retention histories differ.
5. **Atomicity:** authorize the consumer run/attempt and check fences, retained metadata, exact reference and pin cap, then insert on the lake connection in one immediate transaction. No author code, awaited I/O or writes through another SQLite connection occur in it. Retry pin SQLITE_BUSY internally for at most 250 ms, interruptibly and outside transactions, before returning transient Busy. Reclamation apply takes an immediate write lock before re-checking protection and tombstoning; it preserves its existing external error/receipt behavior if contention prevents apply. A pin acquired after planning causes that candidate to be skipped. The meaningful contention proofs involve host-store/engine connections holding write locks across the read/apply, since pin and apply on one lake connection cannot interleave within their synchronous transactions.
6. **Reports:** source publications stay protected while any armed report generation for that source run is WaitingSource, Queued, Running or NeedsAttention. Arm-before-dispatch closes the gap before materialization/promotion. Protection includes the whole source run's publications because reporters can query the source, not just the target invocation. Succeeded, Failed, Cancelled and NotApplicable reports do not protect. A bulk cancellation keeps protection until its selected records settle. A later report retry protects whatever remains from its acceptance onward, but never resurrects reclaimed data or guarantees content during the settled gap.
7. **Operator visibility:** `protectedVersions` becomes the number of eligible versions protected by any of these rules, each counted once. Add optional `protectedBy: { producerVersions, consumerVersions, reportVersions }` counts to plan replies; categories can overlap and are not summed. Counts describe the same inspected scope as protectedVersions. Existing reclamation byte fields retain their meaning.
8. **Inspecting holds:** version-list entries gain optional `protection: { producerRunId: string | null, consumerRunIds: readonly string[], consumerRunCount: number, reportSourceRunId: string | null, truncated: boolean }`. Return at most 20 consumer IDs per version, stable ordered, plus the total count and truncation. The CLI points to run get/cancel for consumer holds and report list/cancel for source report holds. These dynamic details are current state, not frozen by the version-list cursor. Old replies omit them, rather than implying no protection. A missing consumer row still appears by ID as a conservative hold; it indicates inconsistent repository state. The remedy is diagnosis/restoration of consistent state, not silently deleting that dependency. Normal operation does not prune run rows today.

The report hold predicate needs an indexed source lookup, not an independent large report join per artifact version. The [160,000-report scale and projection probes](artifact-reads-evidence.md#report-protection-query-scale--implementation-constraint) establish the risk and one private implementation approach. A maintained projection must be updated atomically with report arming/status/retry changes and backfilled transactionally; transaction-local source caches must not outlive their transaction. This is an implementation constraint, not another public protection rule.

Open POSIX descriptors keep serving an already-open CLI download as before; this feature does not introduce download leases or change pendingBytes into a reader-wait counter. Reader pins are durable version protection, not a measure of socket/file descriptor lifetime.

## Testing contract

The default Task.test reader must support both fixtures and the test's own publications. A separately supplied fake cannot see the publication recorder without a shared harness store.

Propose `Artifact.fixture(definition, value, options?)`, an Effect returning an opaque `Artifact.Fixture<A>` with a public `.reference`. JSON uses the decoded definition type; bytes accept Uint8Array, not a stream. Options are `{ taskId?, output?, key?, version?, tags?, committedAt?, runId?, attemptId?, invocationPath?, revision? }`.

Defaults are taskId `fixture`, output `value`, key = the definition's `id`, version 1, empty tags, runId `fixture-run`, attemptId `fixture-attempt`, invocationPath `task`, revision `fixture-revision`. Definition supplies schemaId/schemaVersion/kind/contentType; content supplies its canonical encoded byte length and real SHA-256. Fixture artifactId uses the lake identity formula with a fixed harness principal `test-owner`, distinct from the production owner principal. Different definitions therefore have different default fixture identities; multiple fixtures for one definition need distinct keys or versions. The helper validates and encodes under publication rules inside an Effect, owns its content, and computes the digest asynchronously. Malformed fixtures fail TaskRuntimeError/InvalidBoundary without content or codec issue text. No ambient host access occurs.

Assign sequences at harness seeding in array order, then in publication order. Higher versions of the same artifactId must appear later or seeding fails. A default committedAt is one millisecond after the greatest timestamp among earlier seeded or published rows (epoch plus one millisecond for the first row); explicit canonical timestamps are preserved. Reject a seeded version history whose timestamps run backwards within the same artifactId, or whose next default timestamp cannot be represented canonically. Exported fixtures retain whether their timestamp was explicit or defaulted so a later harness can assign its own deterministic sequence/default timestamp without mutating them. No wall-clock time is involved. The fixture reference is independent of these metadata defaults.

`Task.test(task, { input, artifacts?: readonly Artifact.Fixture[] })` seeds a private in-memory store and shares it between the default publisher and reader. The result adds `artifacts`, a frozen fixture collection containing the supplied fixtures and recorded publications. Existing publication references remain unchanged when there are no fixtures. Seeded identities can instead reuse an artifactId at a later version. This enables:

```ts
// PROPOSED, not checked against an implementation.
const roundTrip = Effect.gen(function* () {
  const produced = yield* Task.test(Collect, { input: "platform" });
  return yield* Task.test(Inspect, {
    input: produced.value,
    artifacts: produced.artifacts,
  });
});
```

This preserves the producer's exact returned refs; it does not decode and rebuild them under different identities.

Fixture internals hold real content digests even when a recorded reference has the existing synthetic test-digest-N. Only the harness accepts those synthetic aliases. Production readers reject them. Within one test, allocate new synthetic artifact IDs and digest aliases after the highest seeded alias of each kind. Publishing to a seeded logical identity reuses its artifactId and advances its version; repeats of the same publication key within the test keep today's fingerprint/idempotency behavior. Conflicting fixture refs/identities fail before execution; identical repeated fixtures can be deduplicated. Combining independent test collections with colliding synthetic IDs is an explicit fixture error, not last-write-wins.

Enforce both directions of identity ↔ artifactId. Each (artifactId, version) names exactly one reference and stored content; a synthetic digest alias cannot name different content. Real content digests may repeat across identities/versions, as they do in production. Different synthetic aliases may also describe equal content; never rewrite an exported reference merely to deduplicate it. A hashed fixture and an exported synthetic reference for the same identity cannot be merged. The error for alias collisions tells authors to seed the next producer with the previous result's artifacts; the error for repeated default identities says to provide distinct keys or explicit increasing versions. A mixed reference with a seeded hashed artifactId and a new synthetic digest is valid only in the harness.

For multiple producers, thread the fixture store rather than concatenating independent results:

```ts
// PROPOSED; uses Collect from the complete example below.
const multipleProducers = Effect.gen(function* () {
  const first = yield* Task.test(Collect, { input: "platform" });
  const second = yield* Task.test(Collect, {
    input: "infra",
    artifacts: first.artifacts,
  });
  return {
    first: first.value,
    second: second.value,
    artifacts: second.artifacts,
  };
});
```

Own publications become visible to subsequent reads/query/latest in the same test, with actual task/output/key metadata. Exported fixtures retain that metadata across the two-test handoff. No pin durability, SQLite locking or restart is simulated. Runtime readers and fixture readers share reference checks, codec/error mapping and query semantics; synthetic-reference handling is a documented harness-only exception. A fake supplied by Task.provide replaces the reader, and publication fakes still replace the recorder as today.

The store owns independent content copies, separate from mutable public TestPublication.bytes. Every bytes result/stream chunk is a fresh copy; JSON reads decode freshly parsed stored text. Freeze fixture objects and references. Seeding and version advancement never mutate an incoming fixture. Capture the first writer's query-field catalogue per schema ID/version, reject conflicting subsequent writers as production does, and use that catalogue for queries even when a reading definition object differs.

`Report.test` gains the same optional artifacts argument, forwards it to Task.test and returns the resulting artifacts. Fixtures can set runId to the report source's runId. Publications exported from Task.test use its existing `test-run` ID, so Report.test handoffs set source.runId to `test-run`; explicit fixtures can use another source ID.

No new read-log result field is proposed. Assertions use task output, fixtures or an ordinary fake's own recorder.

## Complete authoring example

Proposed SDK additions make this illustrative, **not yet typechecked**. Existing Task/Workflow shapes were checked against source. The implementation proof must compile and execute this example.

```ts
import {
  Application,
  Artifact,
  ArtifactReader,
  ArtifactStorage,
  ArtifactReadError,
  ArtifactUnavailable,
  Report,
  Task,
  Workflow,
} from "@offtree/effectory-sdk";
import { Effect, Schema } from "effect";

const Inventory = Artifact.make({
  id: "inventory",
  version: 1,
  schema: Schema.Struct({
    team: Schema.String,
    hosts: Schema.Array(Schema.String),
  }),
  fields: [["team"]],
});
const ReadErrors = Schema.Union([ArtifactReadError, ArtifactUnavailable]);

const Collect = Task.make(
  {
    id: "collect",
    version: 1,
    replay: "idempotent",
    input: Schema.String,
    success: Inventory.refSchema,
    error: Schema.Never,
    outputs: { inventory: Inventory },
  },
  (team) =>
    Effect.gen(function* () {
      const storage = yield* ArtifactStorage;
      return yield* storage.publish(
        Inventory,
        { team, hosts: ["a", "b"] },
        { key: team }
      );
    })
);

const Inspect = Task.make(
  {
    id: "inspect",
    version: 1,
    replay: "idempotent",
    input: Inventory.refSchema,
    success: Schema.Number,
    error: ReadErrors,
  },
  (reference) =>
    Effect.gen(function* () {
      const reader = yield* ArtifactReader;
      const inventory = yield* reader.get(Inventory, reference);
      return inventory.hosts.length;
    })
);

const Audit = Workflow.make(
  {
    id: "audit",
    version: 1,
    input: Schema.String,
    success: Schema.Number,
    error: ReadErrors,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const team = yield* graph.input(Schema.String);
    const reference = yield* graph.task("collect", Collect, team);
    return yield* graph.task("inspect", Inspect, reference, {
      retry: { attempts: 3, delay: "5 seconds", when: ["ArtifactUnavailable"] },
    });
  })
);

export default Application.make({
  tasks: [Collect, Inspect],
  workflows: [Audit],
}) satisfies Application.Application<never>;
```

For a previous run, an Effect handler can call `reader.latest(Inventory, { taskId: Collect.id, output: "inventory", key: "platform" })` and then get the resulting ref. A reporter can query `versions: "all"` with `metadata.runId = source.runId`, then read each row.ref. A bytes consumer chooses stream for incremental processing or bytes for integrity before acting. Each of these uses the same declared read-error union and task-local Layer substitution.

### Acquire before a durable wait

Proposed, using the definitions above. A cross-run reference is acquired by an ordinary graph task before the approval opens. Reclamation can still win before Acquire executes; after success the hold lasts for this entire workflow run.

```ts
const Acquire = Task.make(
  {
    id: "acquire-inventory",
    version: 1,
    replay: "idempotent",
    input: Inventory.refSchema,
    success: Inventory.refSchema,
    error: ReadErrors,
  },
  (reference) =>
    Effect.gen(function* () {
      const reader = yield* ArtifactReader;
      yield* reader.metadata(Inventory, reference);
      return reference;
    })
);

const ReviewInventory = Workflow.make(
  {
    id: "review-inventory",
    version: 1,
    input: Inventory.refSchema,
    success: Schema.Number,
    error: ReadErrors,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const reference = yield* graph.input(Inventory.refSchema);
    const held = yield* graph.task("acquire", Acquire, reference);
    const approval = yield* graph.approval("approve", {
      prompt: "Inspect this inventory?",
      timeout: "7 days",
      after: [held],
    });
    return yield* graph.task("inspect", Inspect, held, { after: [approval] });
  })
);
```

### Reporter fixture example

Proposed additions are not yet typechecked. This shows the complete fixture-to-query path rather than a mock reader that bypasses storage behavior.

```ts
const InventoryReport = Task.make(
  {
    id: "inventory-report",
    version: 1,
    replay: "idempotent",
    input: Report.sourceOf(Collect),
    success: Report.result(Schema.Int),
    error: ReadErrors,
  },
  (source) =>
    Effect.gen(function* () {
      const reader = yield* ArtifactReader;
      const page = yield* reader.query(Inventory, {
        versions: "all",
        where: {
          _tag: "Eq",
          field: { metadata: "runId" },
          value: source.runId,
        },
      });
      const inventories = yield* Effect.forEach(page.rows, (row) =>
        reader.get(Inventory, row.ref)
      );
      const hosts = inventories.reduce(
        (total, item) => total + item.hosts.length,
        0
      );
      return { data: hosts, markdown: `${hosts} hosts on this page` };
    })
);

const reporterTest = Effect.gen(function* () {
  const fixture = yield* Artifact.fixture(
    Inventory,
    { team: "platform", hosts: ["a", "b"] },
    {
      taskId: Collect.id,
      output: "inventory",
      key: "platform",
      runId: "source-1",
    }
  );
  return yield* Report.test(InventoryReport, {
    source: {
      invocationId: null,
      revision: "fixture-revision",
      runId: "source-1",
      scope: "run",
      status: "Succeeded",
      targetId: Collect.id,
      targetKind: "task",
      targetVersion: 1,
    },
    outcome: { _tag: "Succeeded", value: fixture.reference },
    artifacts: [fixture],
  });
});
```

## Approved compatibility decisions

- Separate ArtifactReader, six methods, and the normal ArtifactQuery.stream helper; explicit latest identity; byte-stream versus verified whole-byte semantics.
- Two explicit error tags; no implicit widening of all task error channels. Codec defects become safe DecodeFailed errors.
- First-access protection, 1,024 external pins per run, report-source protection, and the operator retention amendment. No input-schema pin walker.
- Four shared binary-reading/publishing invocations, each with up to four active binary reads, plus the existing four writers. JSON reads bypass binary admission. Finite binary reads queue locally; four open streams make further reads fail ConcurrencyLimit. Binary publications now enter the shared admission queue before the writer pool. Accept the queueing/fairness and buffering tradeoffs explicitly; no publication error widening is proposed.
- Task.test fixture handoff and own-publication reads, preserving existing synthetic refs and clearly distinguishing harness behavior.
- Alternatives to shared admission, not selected: (a) read-then-publish fails fast when writers are saturated, requiring a new publish-side Busy type or acceptance as a host failure; (b) a read pulled while holding a writer fails ArtifactUnavailable/Busy when reader slots are saturated, affecting ordinary stream copy. Shared admission makes both wait, at the cost that long readers can delay existing bytes publishers.
- Existing publish signatures, CLI download/get commands, query wire syntax and reclamation byte meanings remain compatible; binary publication scheduling changes as described above. New runtime bridges and SDK modules require regenerated host loaders and the usual daemon/application rebuild. A low-level Task.execute runtime with no reader bridge fails Unsupported. An older daemon may instead refuse the application during loading/ABI checks and needs upgrading/restarting; it cannot supply the reader or fall back to ambient files.

## Proof gates before completion

1. Real SDK inference, wrong schema/kind/ref rejection, runtime schemaVersion mismatch, explicit task errors/retry, Layer error propagation and reader requirement exclusion. Existing publish-only fakes keep compiling.
2. Actual producer/consumer workflow, standalone helper, task-local Layer, two-stage Task.test handoff, own-publication read, binary fixtures and full query parity. Compile and execute the example above.
3. Immediate pin/apply transactions under real engine/host write-lock contention, bounded internal retries, plan→pin→apply, shared-digest reclamation, busy mapping, idempotent repeated reads, PinLimit and same-run/reporter-source exemptions.
4. Failure→retry, acquire-before-wait, NeedsAttention, kill/restart and terminal cleanup. Closed handles/streams cannot open/read after invocation end or end as a short success. No descriptor/child-fiber leak. Eight concurrent reading tasks queue without failure, nested reads up to the local cap work without global hold-and-wait, finite binary-read fan-out queues, four open streams plus a read fails predictably, and JSON fan-out works with every binary slot occupied. Cancellation releases queued/admitted slots. Test simultaneous first reservations, leader interruption, cancellation racing grant, last-release/new-acquire, close while pending and no FIFO barging. Exercise both copy pipelines and read-then-publish with real binary storage under saturated writer/shared pools; neither may stall from pool-order inversion. Run both start orders against real createBinaryStorage with every invocation slot and writer permit occupied. Test close with a publication still queued, prompt publication interruption, and that a held slot is not returned until descriptor/staging cleanup and writer release finish. Task.test and the host must both complete eight-way copy fan-out. A publish-only attempt queued behind long readers may time out, but must leak no permit or gain a Busy error. No uninterruptible acquisition wait may defer cancellation until a grant.
5. Queued/unmaterialized reports protect source publications, including while the source waits. A reporter reads more than 1,024 of its source's publications without hitting PinLimit. Bulk cancellation eventually releases protection. Test source-index migration, rollback and crash recovery, plus large pending and large settled source histories without per-version report scans. Explicit later regeneration returns Reclaimed if data was removed in the gap.
6. Query latest-before-filter, versions across schema changes, identity lookup by task/output/key, cursor binding/reopen/expiry, unrelated reclamation invalidation and no automatic stream restart. A report query among 100,000 unrelated rows stays within candidate budgets; compound/null/missing/pushdown semantics match the shared evaluator.
7. Async/throwing codecs, strict decoding, sensitive issue text never persisted, and interruption during a codec finalizer that dies with sensitive text: no leaked cause/record/log. No author decoder within a transaction; complete/early/corrupt byte reads and verified bytes before side effects.
8. Reclamation plan/category counts including overlap, 20-ID hold truncation, apply rechecks and unchanged byte receipts. New client accepts missing optional protection details from old replies.
9. Installed extension artifact definitions retain inferred ref types, equivalent definitions read structurally, and a real daemon restart restores consumer protection and provider ownership.
10. Shared query schema object identity and unchanged wire decoding. Report.test artifact forwarding, multi-producer fixture threading, deterministic metadata/history order including mixed explicit/default timestamps across different identities using the greatest earlier timestamp, noncolliding seeded digest aliases, repeated real content digests, identity conflict rejection and immutable content despite mutations of public bytes/chunks. Regenerate SDK host modules, update public docs/examples and pass typecheck, check and the integrated test suite.

## Review resolution and approval status

The [Effect round-4 review](artifact-reads-review-effect-round4.md) conditionally approves presentation after W1–W3 and a proof-gate sentence; all are incorporated. It tested the ordering against the real binary writer with a stand-in admission owner and reader. The [consumer round-4 review](artifact-reads-review-consumer-round4.md) conditionally approves after L1–L4; all are incorporated. No further review round is required by either reviewer.

The accepted presentation includes the shared binary scheduling amendment, its effect on existing write-only tasks, the alternatives and the harness writer bound. Reviewer approval is not user approval, and stand-in probes are not implementation tests. The user approved the methods, retention rules, limits, testing additions and shared scheduling amendment on 2026-11-06. Implementation and current verification are tracked in [artifact-reads-implementation.md](artifact-reads-implementation.md).

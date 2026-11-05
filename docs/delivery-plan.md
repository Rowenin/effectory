# Delivery plan and acceptance criteria

The [implementation readiness roadmap](implementation-roadmap.md) refines this initial sequence after the five focused planning passes. Use its milestones for the next implementation work; retain the evidence and requirements below as background, not as a claim that any proposed runtime is already proven.

This pass produces design documentation and local source references only. The following work is ordered to validate the riskiest assumptions before expanding feature coverage.

## 1. Establish the library and prove the engine

Reconcile the stale workspace dependency/scripts, establish the package layout, and retain the Effect 4.0.5 pin. Compile an RPC definition and handler Layer, a Task spec with inferred services, and a persistent Effect workflow using SingleRunner, SQLite and platform Crypto. Verify the exact protocol transport Layer composition on Bun.

Exit criteria: schema round trips and negative type fixtures pass; submit a one-activity workflow, kill the process, restart, and observe its stored result. Confirm activity identities and outbox deduplication. If this engine assembly cannot meet recovery requirements, document the specific gap before committing to a custom WorkflowEngine adapter. Do not start by implementing a second engine.

## 2. End-to-end task execution

Build RunService, durable submission/outbox, event log, daemon lifecycle, RPC client and CLI. Add immutable artifact publication and metadata queries. One example task should produce a typed JSON artifact, run in the background and be observable from a second CLI process.

Exit criteria: disconnected CLI does not cancel work; duplicate submit returns one run; changed payload with reused key conflicts; restart recovers accepted work; cancellation settles subprocesses; invalid input never reaches a handler; metadata-only query reads no blobs. Test concurrent publication and crash gaps.

## 3. Workflow composition and durable waits

Build graph validation, dependencies, bounded parallelism/fan-out, conditions, nesting, retry, deadlines, approvals and signals. Pin revisions and input values. Implement the run projection reconciler and explicit uncertain-side-effect state.

Exit criteria: dependency cycles fail before submission; a suspended run resumes with the original graph, inputs and bundles; duplicated/conflicting signals behave as documented; cancelled parents settle linked children; failed projection is repaired after restart; retry does not duplicate a committed artifact.

## 4. GitHub extension lifecycle and provider overrides

Implement the manifest, release downloader via `gh`, immutable bundle cache, lockfile, dependency resolution and activation recovery. Ship a small reference extension with tasks, a workflow and a replaceable provider. Document its build format and publishable archive layout.

Exit criteria: public/private download paths work; offline locked restore works; replaced assets fail integrity validation; traversal and dependency cycles fail; duplicate IDs and conflicting overrides fail; interrupted activation recovers; upgrades affect new runs only; referenced bundles cannot be removed.

## 5. Lake queries and operator readiness

Add JSON field filtering/projection, snapshot pagination, retention leases, lineage, schema migration tasks, repair and backup/restore. Add discovery/schema export, structured diagnostics and run history suitable for external agents.

Exit criteria: query results match a reference evaluator; authorization happens before limit; pagination is stable under concurrent writes; expired cursors are explicit; pinned data survives GC; restores resume waiting runs; malformed schemas/cursors never become defects. Run realistic bounded-memory load tests.

## Later parity

Cron and authenticated webhook triggers; remote Executor workers; distributed coordination; external vault and object-store providers; report/UI adapters; agent skill installation; Swamp import tooling. Each should use the same spec, submission and lake boundaries rather than introducing alternate execution paths.

## Decisions to revisit with evidence

| Decision | Initial proposal | What could change it |
| --- | --- | --- |
| Workflow engine | Effect persistent single runner | Crash tests expose an unmet invariant |
| Runtime | Bun on one host | Required platform adapter or extension compatibility |
| RPC transport | Authenticated loopback HTTP | Socket support and cross-platform requirements |
| Workflow authoring | Typed graph builder | Need for arbitrary Effect programs or portable YAML imports |
| GitHub packages | Prebuilt ESM release bundles via `gh` | Need for source-only installs, provenance signing or registry search |
| Storage | SQLite metadata plus local blobs | Multi-host coordination and scale measurements |
| Trust | Trusted in-process providers; isolated task execution where needed | Requirement to execute untrusted third-party code |
| Query language | Bounded schema-defined AST | Concrete analytics use cases needing joins/SQL |

## Documentation-pass verification

Source revisions are in [vendor/manifest.json](../vendor/manifest.json). The restore script checks clean matching checkouts without changing them. Relative documentation links should resolve with the source references present. Run the repository's required checks:

```sh
bun run typecheck && bun run check && bun test
```

These checks do not typecheck proposed Markdown APIs. No runtime behavior or Swamp/Effect upstream test suite is claimed as verified by this pass.

### Observed results in this checkout

- Vendor restore verification, shell syntax validation, local Markdown link checks and `git diff --check` passed.
- `bun run typecheck` could not start: `tsc` is not installed.
- `bun run check` could not start: `ultracite` is not installed.
- `bun install --frozen-lockfile` refused the missing `packages/flow` workspace referenced by the root dependency and lockfile. No dependency pins were changed.
- `bun test` reported no tests after excluding upstream references.

Full type/lint validation remains blocked on repairing the pre-existing package scaffold. These results are not a passing implementation test suite.

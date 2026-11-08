# Manual recovery: native engine continuation probe

Executed 2026-11-06 against the installed Effect 4.0.5 and the current `engineLayer` / ownership Layer. Research only; no recovery API or authorization implementation exists.

A parent executes a recorded Activity, then awaits a child workflow. The child suspends inside its Activity while an in-memory boolean denies entry. The probe waits until both workflows report Suspended, changes that boolean and invokes one of three wake strategies. Each scenario gets its own SQLite database and scoped engine, removed after exit.

- **Parent resume only:** parent remained suspended throughout 200 polls with 10 ms sleeps; no second child entry. This is bounded observation, not proof it could never wake from another event.
- **Leaf resume only:** leaf re-entered once, returned 42 and woke the linked parent. The earlier successful Activity remained at one execution.
- **Both resume:** also completed with one earlier Activity execution and one authorized child body execution.

This supports dispatching recovery to the stored leaf execution ID. Merely waking the root is insufficient in this experiment. It does not establish durable authorization, host attempt-guard changes, recovery under process death, sibling quiescence, deadline semantics or operator idempotency. The boolean is deliberately a stand-in and is not a proposed persistence design.

All three subprocesses exited 0. Exact output:

```jsonl
{"mode":"root","before":{"first":1,"entries":1,"external":0},"after":{"first":1,"entries":1,"external":0},"result":"still suspended"}
{"mode":"leaf","before":{"first":1,"entries":1,"external":0},"after":{"first":1,"entries":2,"external":1},"result":{"exit":{"_id":"Exit","_tag":"Success","value":42},"_tag":"Complete","~effect/workflow/Workflow/Result":"~effect/workflow/Workflow/Result"}}
{"mode":"both","before":{"first":1,"entries":1,"external":0},"after":{"first":1,"entries":2,"external":1},"result":{"exit":{"_id":"Exit","_tag":"Success","value":42},"_tag":"Complete","~effect/workflow/Workflow/Result":"~effect/workflow/Workflow/Result"}}
```

## Reproduction script

The executed scratch file was `/tmp/effectory-manual-recovery-proof/native-resume.ts`. Run it with `leaf`, `root` or `both`. Absolute imports below pin the checkout and installed package used in this experiment; adjust them when reproducing elsewhere. No external action or credential was involved.

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Effect,
  Layer,
  Option,
  Schema,
  Schedule,
} from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/node_modules/.bun/effect@4.0.5/node_modules/effect/dist/index.js";
import {
  Activity,
  Workflow,
} from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/node_modules/.bun/effect@4.0.5/node_modules/effect/dist/workflow/index.js";
import { WorkflowInstance } from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/node_modules/.bun/effect@4.0.5/node_modules/effect/dist/workflow/WorkflowEngine.js";
import { engineLayer } from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/packages/platform-bun/src/engine.ts";
import { ownershipLayer } from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/packages/platform-bun/src/ownership.ts";
const directory = await mkdtemp(
  path.join(tmpdir(), "effectory-manual-resume-")
);
const mode = process.argv[2] ?? "leaf";
let allowed = false,
  first = 0,
  entries = 0,
  external = 0;
const child = Workflow.make("RecoveryProbeChild", {
  payload: { id: Schema.String },
  success: Schema.Int,
  idempotencyKey: (p) => p.id,
});
const parent = Workflow.make("RecoveryProbeParent", {
  payload: { id: Schema.String },
  success: Schema.Int,
  idempotencyKey: (p) => p.id,
});
const childLayer = child.toLayer(() =>
  Activity.make({
    name: "manual",
    success: Schema.Int,
    interruptRetryPolicy: Schedule.recurs(0),
    execute: Effect.gen(function* () {
      entries += 1;
      if (!allowed) return yield* Workflow.suspend(yield* WorkflowInstance);
      external += 1;
      return 42;
    }),
  })
);
const parentLayer = parent.toLayer((p) =>
  Effect.gen(function* () {
    yield* Activity.make({
      name: "first",
      success: Schema.Int,
      execute: Effect.sync(() => ++first),
      interruptRetryPolicy: Schedule.recurs(0),
    });
    return yield* child.execute(p);
  })
);
try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const payload = { id: "same" };
      const childId = yield* child.executionId(payload);
      const parentId = yield* parent.execute(payload, { discard: true });
      let suspended = false;
      for (let i = 0; i < 200; i++) {
        const a = yield* parent.poll(parentId),
          b = yield* child.poll(childId);
        if (
          Option.isSome(a) &&
          a.value._tag === "Suspended" &&
          Option.isSome(b) &&
          b.value._tag === "Suspended"
        ) {
          suspended = true;
          break;
        }
        yield* Effect.sleep("10 millis");
      }
      if (!suspended)
        return yield* Effect.die("Did not suspend both workflows");
      const before = { first, entries, external };
      allowed = true;
      if (mode === "root" || mode === "both") yield* parent.resume(parentId);
      if (mode === "leaf" || mode === "both") yield* child.resume(childId);
      let result;
      for (let i = 0; i < 200; i++) {
        const current = yield* parent.poll(parentId);
        if (Option.isSome(current) && current.value._tag !== "Suspended") {
          result = current.value;
          break;
        }
        yield* Effect.sleep("10 millis");
      }
      console.log(
        JSON.stringify({
          mode,
          before,
          after: { first, entries, external },
          result: result ?? "still suspended",
        })
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(childLayer, parentLayer).pipe(
          Layer.provideMerge(engineLayer(path.join(directory, "state.sqlite"))),
          Layer.provide(ownershipLayer(path.join(directory, "owner.sqlite")))
        )
      )
    )
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

## Process-death and duplicate-wake extension

A separate probe now uses three real Bun processes and a persistent audit SQLite database. Process one records the parent's first Activity, suspends both workflows and publishes a readiness marker. The driver sends SIGKILL and waits for exit. Process two starts the same engine/database with its permission flag **false**, observes the retained child state, records audit counters, then enables the stand-in permission and resumes the leaf. Process three starts again and sends duplicate child/root wakes against the completed execution.

Assertions passed: parent and child execution IDs stayed identical; no synthetic external effect had executed before the explicit permission change in process two; the parent's first Activity stayed at one execution; the synthetic external effect executed once; duplicate wakes in process three left both counters unchanged and returned 42. This confirms durable continuation and completed-result reuse in this particular sequence. It does **not** exercise a crash after an external action but before recording its outcome, nor the proposed durable authorization-consumption transaction.

The initial exploratory variant enabled permission on process startup, which could confound explicit resume with startup behavior. The retained result below is the corrected rerun with permission false until the stored child state was observed.

Executed with `python3 /tmp/effectory-manual-recovery-proof/run-process.py`. The driver removed its temporary repositories and awaited every child process. Exact corrected result:

```json
{
  "beforeKill": {
    "parentId": "330bcdde887f3bddf9141a79785c1c27",
    "childId": "2723b3bff47dedfda75616351574caf5",
    "counts": [
      {
        "id": "entries",
        "n": 1
      },
      {
        "id": "first",
        "n": 1
      }
    ]
  },
  "afterRestart": [
    {
      "mode": "recover",
      "parentId": "330bcdde887f3bddf9141a79785c1c27",
      "childId": "2723b3bff47dedfda75616351574caf5",
      "beforeWake": [
        {
          "id": "entries",
          "n": 1
        },
        {
          "id": "first",
          "n": 1
        }
      ],
      "counts": [
        {
          "id": "entries",
          "n": 2
        },
        {
          "id": "external",
          "n": 1
        },
        {
          "id": "first",
          "n": 1
        }
      ],
      "result": {
        "exit": {
          "_id": "Exit",
          "_tag": "Success",
          "value": 42
        },
        "_tag": "Complete",
        "~effect/workflow/Workflow/Result": "~effect/workflow/Workflow/Result"
      }
    },
    {
      "mode": "duplicate",
      "parentId": "330bcdde887f3bddf9141a79785c1c27",
      "childId": "2723b3bff47dedfda75616351574caf5",
      "beforeWake": [
        {
          "id": "entries",
          "n": 2
        },
        {
          "id": "external",
          "n": 1
        },
        {
          "id": "first",
          "n": 1
        }
      ],
      "counts": [
        {
          "id": "entries",
          "n": 2
        },
        {
          "id": "external",
          "n": 1
        },
        {
          "id": "first",
          "n": 1
        }
      ],
      "result": {
        "exit": {
          "_id": "Exit",
          "_tag": "Success",
          "value": 42
        },
        "_tag": "Complete",
        "~effect/workflow/Workflow/Result": "~effect/workflow/Workflow/Result"
      }
    }
  ]
}
```

### Process probe

```ts
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Effect,
  Layer,
  Option,
  Schema,
  Schedule,
} from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/node_modules/.bun/effect@4.0.5/node_modules/effect/dist/index.js";
import {
  Activity,
  Workflow,
} from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/node_modules/.bun/effect@4.0.5/node_modules/effect/dist/workflow/index.js";
import { WorkflowInstance } from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/node_modules/.bun/effect@4.0.5/node_modules/effect/dist/workflow/WorkflowEngine.js";
import { engineLayer } from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/packages/platform-bun/src/engine.ts";
import { ownershipLayer } from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/packages/platform-bun/src/ownership.ts";
const directory = process.argv[3];
if (!directory) throw Error("Expected directory");
const audit = new Database(path.join(directory, "audit.sqlite"));
audit.exec(
  "CREATE TABLE IF NOT EXISTS counts (id TEXT PRIMARY KEY, n INTEGER NOT NULL)"
);
const increment = (id) => {
  audit
    .query(
      "INSERT INTO counts VALUES (?,1) ON CONFLICT(id) DO UPDATE SET n=n+1"
    )
    .run(id);
  return audit.query("SELECT n FROM counts WHERE id=?").get(id).n;
};
const counts = () => audit.query("SELECT id,n FROM counts ORDER BY id").all();
const mode = process.argv[2] ?? "leaf";
let allowed = false,
  first = 0,
  entries = 0,
  external = 0;
const child = Workflow.make("RecoveryProbeChild", {
  payload: { id: Schema.String },
  success: Schema.Int,
  idempotencyKey: (p) => p.id,
});
const parent = Workflow.make("RecoveryProbeParent", {
  payload: { id: Schema.String },
  success: Schema.Int,
  idempotencyKey: (p) => p.id,
});
const childLayer = child.toLayer(() =>
  Activity.make({
    name: "manual",
    success: Schema.Int,
    interruptRetryPolicy: Schedule.recurs(0),
    execute: Effect.gen(function* () {
      entries = increment("entries");
      if (!allowed) return yield* Workflow.suspend(yield* WorkflowInstance);
      external = increment("external");
      return 42;
    }),
  })
);
const parentLayer = parent.toLayer((p) =>
  Effect.gen(function* () {
    yield* Activity.make({
      name: "first",
      success: Schema.Int,
      execute: Effect.sync(() => {
        first = increment("first");
        return first;
      }),
      interruptRetryPolicy: Schedule.recurs(0),
    });
    return yield* child.execute(p);
  })
);
try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const payload = { id: "same" };
      const childId = yield* child.executionId(payload);
      const parentId = yield* parent.execute(payload, { discard: true });
      if (mode === "prepare") {
        let suspended = false;
        for (let i = 0; i < 200; i++) {
          const a = yield* parent.poll(parentId),
            b = yield* child.poll(childId);
          if (
            Option.isSome(a) &&
            a.value._tag === "Suspended" &&
            Option.isSome(b) &&
            b.value._tag === "Suspended"
          ) {
            suspended = true;
            break;
          }
          yield* Effect.sleep("10 millis");
        }
        if (!suspended) return yield* Effect.die("Did not suspend both");
        yield* Effect.promise(() =>
          Bun.write(
            path.join(directory, "ready.json"),
            JSON.stringify({ parentId, childId, counts: counts() })
          )
        );
        return yield* Effect.never;
      }
      let observed = false;
      for (let i = 0; i < 200; i++) {
        const current = yield* child.poll(childId);
        if (Option.isSome(current)) {
          observed = true;
          break;
        }
        yield* Effect.sleep("10 millis");
      }
      if (!observed) return yield* Effect.die("No persisted child state");
      const beforeWake = counts();
      allowed = true;
      yield* child.resume(childId);
      // Duplicate operator wakes must not repeat a committed activity.
      if (mode === "duplicate") {
        yield* child.resume(childId);
        yield* parent.resume(parentId);
      }
      let result;
      for (let i = 0; i < 200; i++) {
        const current = yield* parent.poll(parentId);
        if (Option.isSome(current) && current.value._tag !== "Suspended") {
          result = current.value;
          break;
        }
        yield* Effect.sleep("10 millis");
      }
      console.log(
        JSON.stringify({
          mode,
          parentId,
          childId,
          beforeWake,
          counts: counts(),
          result: result ?? "still suspended",
        })
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(childLayer, parentLayer).pipe(
          Layer.provideMerge(engineLayer(path.join(directory, "state.sqlite"))),
          Layer.provide(ownershipLayer(path.join(directory, "owner.sqlite")))
        )
      )
    )
  );
} finally {
  audit.close();
}
```

### Driver

```python
import tempfile,subprocess,time,json,shutil
from pathlib import Path
root='/tmp/effectory-manual-recovery-proof'; directory=tempfile.mkdtemp(prefix='effectory-recovery-death-')
script=root+'/process-resume.ts'; first=None
try:
 with open(root+'/prepare.log','w') as log:
  first=subprocess.Popen(['bun',script,'prepare',directory],stdout=log,stderr=log)
  for _ in range(500):
   if Path(directory+'/ready.json').exists(): break
   if first.poll() is not None: raise RuntimeError(Path(root+'/prepare.log').read_text())
   time.sleep(.02)
  else: raise RuntimeError('No ready marker')
  ready=json.loads(Path(directory+'/ready.json').read_text());first.kill();first.wait(timeout=10)
  outputs=[]
  for mode in ['recover','duplicate']:
   completed=subprocess.run(['bun',script,mode,directory],capture_output=True,text=True,timeout=20)
   if completed.returncode: raise RuntimeError(completed.stderr)
   result=json.loads(completed.stdout); outputs.append(result)
   assert result['parentId']==ready['parentId'] and result['childId']==ready['childId']
   assert result['result']['exit']['value']==42
   counts={row['id']:row['n'] for row in result['counts']}
   assert counts['first']==1 and counts['external']==1,counts
   if mode=='recover': assert all(row['id']!='external' for row in result['beforeWake'])
  Path(root+'/process-results.json').write_text(json.dumps({'beforeKill':ready,'afterRestart':outputs},indent=2))
  print(Path(root+'/process-results.json').read_text())
finally:
 if first and first.poll() is None:first.kill();first.wait(timeout=10)
 shutil.rmtree(directory)

```

## Selective fan-out continuation

Executed a further native-engine probe with a parent awaiting two child workflows concurrently. Both children first suspended behind separate in-memory permission gates. Resuming child one completed that child while child two remained Suspended and the parent remained Suspended. Enabling and resuming child two then completed the parent with both results. The preceding parent's recorded Activity executed once, and each permitted synthetic child action executed once. The probe asserted these counts and statuses and exited 0.

This tests selective leaf wake and result retention with the installed SQLite-backed engine. It does not implement or prove bypassing HostStore's global NeedsAttention admission check, durable one-entry authorizations, partial failure, active siblings/finalizers, or process death during selective authorization. Per-invocation selection is feasible at the native engine level; the host still needs a separately reviewed admission protocol.

Executed scratch path: `/tmp/effectory-manual-recovery-proof/fanout-resume.ts`. Exact output:

```json
[
  {
    "stage": "both-held",
    "first": 1,
    "entries": {
      "one": 1,
      "two": 1
    },
    "external": {}
  },
  {
    "stage": "one-complete-two-held",
    "first": 1,
    "entries": {
      "one": 2,
      "two": 1
    },
    "external": {
      "one": 1
    }
  },
  {
    "stage": "both-complete",
    "first": 1,
    "entries": {
      "one": 2,
      "two": 2
    },
    "external": {
      "one": 1,
      "two": 1
    },
    "result": {
      "exit": {
        "_id": "Exit",
        "_tag": "Success",
        "value": [42, 42]
      },
      "_tag": "Complete",
      "~effect/workflow/Workflow/Result": "~effect/workflow/Workflow/Result"
    }
  }
]
```

Complete reproduction source (adjust absolute checkout imports):

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Effect,
  Layer,
  Option,
  Schema,
  Schedule,
} from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/node_modules/.bun/effect@4.0.5/node_modules/effect/dist/index.js";
import {
  Activity,
  Workflow,
} from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/node_modules/.bun/effect@4.0.5/node_modules/effect/dist/workflow/index.js";
import { WorkflowInstance } from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/node_modules/.bun/effect@4.0.5/node_modules/effect/dist/workflow/WorkflowEngine.js";
import { engineLayer } from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/packages/platform-bun/src/engine.ts";
import { ownershipLayer } from "/Users/davidr/.t3/worktrees/effectory/t3-21743e89/packages/platform-bun/src/ownership.ts";
const directory = await mkdtemp(
  path.join(tmpdir(), "effectory-manual-resume-")
);
let first = 0;
const permitted = new Set<string>();
const entries: Record<string, number> = {};
const external: Record<string, number> = {};
const child = Workflow.make("RecoveryFanoutChild", {
  payload: { id: Schema.String },
  success: Schema.Int,
  idempotencyKey: (p) => p.id,
});
const parent = Workflow.make("RecoveryFanoutParent", {
  payload: { id: Schema.String },
  success: Schema.Array(Schema.Int),
  idempotencyKey: (p) => p.id,
});
const childLayer = child.toLayer((p) =>
  Activity.make({
    name: "manual",
    success: Schema.Int,
    interruptRetryPolicy: Schedule.recurs(0),
    execute: Effect.gen(function* () {
      entries[p.id] = (entries[p.id] ?? 0) + 1;
      if (!permitted.has(p.id))
        return yield* Workflow.suspend(yield* WorkflowInstance);
      external[p.id] = (external[p.id] ?? 0) + 1;
      return 42;
    }),
  })
);
const parentLayer = parent.toLayer(() =>
  Effect.gen(function* () {
    yield* Activity.make({
      name: "first",
      success: Schema.Int,
      execute: Effect.sync(() => ++first),
      interruptRetryPolicy: Schedule.recurs(0),
    });
    return yield* Effect.all(
      [child.execute({ id: "one" }), child.execute({ id: "two" })],
      { concurrency: 2 }
    );
  })
);
const requireState = (workflow, id, tag) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1000; i++) {
      const state = yield* workflow.poll(id);
      if (Option.isSome(state) && state.value._tag === tag) return state.value;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(`Expected ${tag} for ${id}`);
  });
try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const one = yield* child.executionId({ id: "one" }),
        two = yield* child.executionId({ id: "two" });
      const root = yield* parent.execute({ id: "root" }, { discard: true });
      yield* requireState(child, one, "Suspended");
      yield* requireState(child, two, "Suspended");
      yield* requireState(parent, root, "Suspended");
      const stages = [];
      stages.push({
        stage: "both-held",
        first,
        entries: { ...entries },
        external: { ...external },
      });
      permitted.add("one");
      yield* child.resume(one);
      yield* requireState(child, one, "Complete");
      // Let parent completion notification/replay settle, then confirm the other child stayed held.
      yield* Effect.sleep("200 millis");
      yield* requireState(parent, root, "Suspended");
      yield* requireState(child, two, "Suspended");
      if (first !== 1 || external.one !== 1 || external.two !== undefined)
        return yield* Effect.die("Unauthorized sibling entry or prior replay");
      stages.push({
        stage: "one-complete-two-held",
        first,
        entries: { ...entries },
        external: { ...external },
      });
      permitted.add("two");
      yield* child.resume(two);
      const result = yield* requireState(parent, root, "Complete");
      if (first !== 1 || external.one !== 1 || external.two !== 1)
        return yield* Effect.die("Duplicate completed work");
      stages.push({
        stage: "both-complete",
        first,
        entries: { ...entries },
        external: { ...external },
        result,
      });
      console.log(JSON.stringify(stages, null, 2));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(childLayer, parentLayer).pipe(
          Layer.provideMerge(engineLayer(path.join(directory, "state.sqlite"))),
          Layer.provide(ownershipLayer(path.join(directory, "owner.sqlite")))
        )
      )
    )
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

# Manual recovery: uncertain external-action experiment

Executed 2026-11-06 against installed Effect 4.0.5, the real SQLite engine Layer and repository ownership Layer. This is a research probe, not a recovery feature or a durable authorization implementation. No real external service, credential or production repository was involved.

## Experiment and result

A parent first completes a recorded Activity. Its child increments a counter in a separate SQLite audit database to represent an external action, writes a readiness marker, then waits forever before returning an Activity result. The driver sends SIGKILL and awaits process exit. This leaves an observable action without a completed native task result.

A fresh process starts with the stand-in permission flag false. The native engine re-enters the unfinished child's body; the gate suspends it before the synthetic action. Only after observing persisted child state does the probe enable permission and resume the leaf. The child performs the action again, returns 42, and wakes its parent. A third process issues duplicate leaf/root wakes against the completed result.

Assertions passed:

- The parent and child retain their execution IDs through all three processes.
- Before death: one earlier completed Activity and one synthetic external action.
- After restart, before explicit permission: another child entry, but still only one synthetic external action.
- After permitted re-entry: two synthetic external actions total; the earlier completed Activity remains at one.
- After the third process and duplicate wakes: both action counts remain unchanged; the parent returns its recorded result.

The extra body entry before authorization is significant: native workflow durability does not itself implement the host's manual-replay policy. The guard must precede task execution and resource acquisition. The explicit second action also demonstrates why a recovery acknowledgment cannot mean that the first action was absent or rolled back. Engine result reuse prevents repeating completed activities; it cannot infer the outcome of an unfinished external action.

## Contract implications and limits

Recovery authorization must be separate from the resume notification. It must be tied to the exact uncertain entry and consumed durably at admission, with duplicate operator requests unable to grant a second entry. A later crash after consumption is another uncertainty; this experiment does not establish that protocol.

The gate here is an in-memory boolean, not HostStore authorization. The proof covers real native engine re-entry, suspension, process death and completed-result reuse with a synthetic action. It does not prove races with live siblings/finalizers, operator idempotency, lost responses, deadlines, report recovery, or schema-safe external reconciliation. Those remain review and implementation gates.

All subprocesses exited or were awaited after SIGKILL, and temporary repositories were deleted. Reproduce with `python3 /tmp/effectory-manual-recovery-proof/run-uncertain.py`. The complete executed scripts and output are retained below because scratch paths are not durable evidence.

## Exact output

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
        "id": "external",
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
          "n": 3
        },
        {
          "id": "external",
          "n": 2
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
          "n": 3
        },
        {
          "id": "external",
          "n": 2
        },
        {
          "id": "first",
          "n": 1
        }
      ],
      "counts": [
        {
          "id": "entries",
          "n": 3
        },
        {
          "id": "external",
          "n": 2
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

## Engine process

Adjust absolute checkout imports when reproducing elsewhere.

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
const childLayer = child.toLayer((payload, childId) =>
  Activity.make({
    name: "manual",
    success: Schema.Int,
    interruptRetryPolicy: Schedule.recurs(0),
    execute: Effect.gen(function* () {
      entries = increment("entries");
      if (mode === "uncertain") {
        external = increment("external");
        const parentId = yield* parent.executionId(payload);
        yield* Effect.promise(() =>
          Bun.write(
            path.join(directory, "ready.json"),
            JSON.stringify({ parentId, childId, counts: counts() })
          )
        );
        return yield* Effect.never;
      }
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
      if (mode === "uncertain") return yield* Effect.never;
      if (mode === "prepare") {
        let suspended = false;
        for (let i = 0; i < 1000; i++) {
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
      for (let i = 0; i < 1000; i++) {
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
      for (let i = 0; i < 1000; i++) {
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

## Driver

```python
import tempfile,subprocess,time,json,shutil
from pathlib import Path
root='/tmp/effectory-manual-recovery-proof'; directory=tempfile.mkdtemp(prefix='effectory-recovery-death-')
script=root+'/uncertain-resume.ts'; first=None
try:
 with open(root+'/prepare.log','w') as log:
  first=subprocess.Popen(['bun',script,'uncertain',directory],stdout=log,stderr=log)
  for _ in range(500):
   if Path(directory+'/ready.json').exists(): break
   if first.poll() is not None: raise RuntimeError(Path(root+'/prepare.log').read_text())
   time.sleep(.02)
  else: raise RuntimeError('No ready marker')
  ready=json.loads(Path(directory+'/ready.json').read_text());first.kill();first.wait(timeout=10)
  outputs=[]
  for mode in ['recover','duplicate']:
   completed=subprocess.run(['bun',script,mode,directory],capture_output=True,text=True,timeout=45)
   if completed.returncode: raise RuntimeError(completed.stderr)
   result=json.loads(completed.stdout); outputs.append(result)
   assert result['parentId']==ready['parentId'] and result['childId']==ready['childId']
   assert result['result']['exit']['value']==42
   counts={row['id']:row['n'] for row in result['counts']}
   assert counts['first']==1 and counts['external']==2,counts
   if mode=='recover': assert {row['id']:row['n'] for row in result['beforeWake']}['external']==1
  Path(root+'/uncertain-results.json').write_text(json.dumps({'beforeKill':ready,'afterRestart':outputs},indent=2))
  print(Path(root+'/uncertain-results.json').read_text())
finally:
 if first and first.poll() is None:first.kill();first.wait(timeout=10)
 shutil.rmtree(directory)

```

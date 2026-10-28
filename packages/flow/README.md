# @effectory/flow

A spike on building DAG workflows with Effect. You define Tasks, `Flow.plan` turns a root Task into a graph, and `Flow.run` executes that graph. Tasks may also declare Tasks they call at run time, for loops and branches that depend on results, and Inputs, where a run stops to wait for a person.

```ts
const RunTests = Flow.Task(
  "RunTests",
  {
    description: "Runs tests.",
    labels: ["testing"],
    input: Schema.Array(Schema.String),
    output: Schema.Boolean,
  },
  (input) =>
    Effect.gen(function* () {
      const installed = yield* Flow.After(InstallDeps, input);
      return {
        run: Effect.gen(function* () {
          const count = yield* installed.output;
          return count === input.length;
        }),
      };
    })
);

const plan = yield * Flow.plan(RunTests, ["effect"]);
const passed = yield * Flow.run(plan);
```

A planner and a reviewer going back and forth, at most three rounds:

```ts
const Refine = Flow.Task(
  "Refine",
  { input: Schema.String, output: Schema.String },
  (goal) =>
    Effect.gen(function* () {
      const draft = yield* Flow.Calls(Draft, { max: 3 });
      const review = yield* Flow.Calls(Review, { max: 3 });
      return {
        run: Effect.gen(function* () {
          let notes: string | undefined;
          for (let round = 0; round < 3; round += 1) {
            const plan = yield* draft({ goal, notes });
            const verdict = yield* review(plan);
            if (verdict.approved) return plan;
            notes = verdict.notes;
          }
          return yield* new NotApproved();
        }),
      };
    })
);
```

The plan shows `Refine` with dashed "may call" edges to `Draft` and `Review`, each capped at 3. Each call becomes a node keyed by its input, such as `Draft({"goal":"ship","notes":"…"})`, once `run` makes it.

A person approving a plan, and the plan only moving on to implementation once they do:

```ts
const ApprovePlan = Flow.Input("ApprovePlan", {
  input: Schema.Struct({ goal: Schema.String, plan: Schema.String }), // what they're shown
  output: Decision, // what they send back
});

// In a body: `const ask = yield* Flow.Calls(ApprovePlan)`; in run: `yield* ask({ goal, plan })`.

const stopped = yield * Flow.run(plan).pipe(Effect.flip);
// Suspended: Waiting for ApprovePlan({"goal":"ship","plan":"ship v0"})
const done =
  yield *
  Flow.run(plan, {
    responses: { [stopped.pending[0].key]: { _tag: "Approve", by: "dana" } },
  });
```

The plan draws Inputs as hexagons, whether planned with `After` or declared with `Calls`, so you can see where a run may stop before running it.

## Durable runs

`Flow.run` keeps nothing between runs. `Flow.start` and `Flow.resume` run through a `RunStore`, so a run can stop at its Inputs, end the process, and continue later without repeating finished work:

```ts
const first = yield * Flow.start(Implement, "ship");
// { _tag: "Suspended", runId, pending: [{ key: 'ApprovePlan("ship v0")', request: "ship v0" }] }

// Later, in another process: respond and continue in one step.
const next =
  yield *
  Flow.resume(Implement, first.runId, {
    responses: { 'ApprovePlan("ship v0")': { _tag: "Approve", by: "dana" } },
  });
// { _tag: "Succeeded", runId, output } (or Suspended again, or Failed)

const { run, nodes } = yield * Flow.status(first.runId);
```

Provide a store with `Flow.memoryStore` (in memory, for tests) or a persistent store. Resuming plans the root again and runs it again; nodes whose outputs are stored return them without running. A node that holds a loop of calls, like `Approve` above, runs again on each resume and replays its calls from the store.

## The two phases

Every Task has two halves, and they run at different times.

| Phase | What runs | What it may do |
| --- | --- | --- |
| **Plan** | The Task body (the function given to `Task`) | Declare dependencies with `Flow.After` and calls with `Flow.Calls`, then return `{ run }`. |
| **Run** | The `run` Effect the body returned | Do the actual work, read the outputs of the Tasks it runs after, and call the Tasks it declared. |

## Laws

The **Enforced by** column says what happens when a law is broken:

- **Type error**: the code doesn't compile.
- **Plan error**: `Flow.plan` fails with a `PlanError`.
- **Run failure**: `Flow.run` fails.
- **By design**: the API gives you no way to break it.
- **Convention**: nothing checks it, so breaking it is up to you to avoid.

### Tasks

| # | Law | ✅ Allowed | ❌ Not allowed | Enforced by |
| --- | --- | --- | --- | --- |
| T1 | A Task has a name, an input schema and an output schema. | Adding a `description` and `labels` as metadata. | A Task without an input or output schema. | Type error |
| T2 | A Task body returns `{ run }`. | Any Effect as `run`, including one that needs services. | Returning the result directly instead of wrapping the work in `run`. | Type error |
| T3 | `run` must produce a value of the output type. | Returning a subtype of the output. | `Effect.succeed()` for a Task whose output is `Schema.Boolean`. | Type error |
| T4 | A Task body only declares dependencies; real work belongs in `run`. | Branching on the Task's own input to choose dependencies. | Side effects in the body (it runs during planning, even if you never run). | Convention |
| T5 | Input and output schemas must encode without services. | Plain and transforming schemas such as `Schema.NumberFromString`. | Schemas whose encoding needs a service. | Type error |

### Nodes

| # | Law | ✅ Allowed | ❌ Not allowed | Enforced by |
| --- | --- | --- | --- | --- |
| N1 | A node is a Task applied to one input. Its key is the Task name plus the input encoded with its schema's JSON codec, e.g. `RunTests(["effect"])`. | One Task appearing as several nodes with different inputs. | — | — |
| N2 | The same Task with the same input is always one node. | Many Tasks declaring `After` on the same Task and input; it runs once. | Expecting a Task to run twice for the same input. | By design |
| N3 | Inputs must be valid for the Task's input schema. | — | Planning or depending on a Task with input that fails its schema. | Plan error |
| N4 | Task names must be unique. | — | Two different Tasks with the same name. If their inputs match, they silently become one node. | Convention |
| N5 | A plan contains only the root and the nodes it depends on, directly or indirectly. | Defining Tasks that aren't reachable from the root; they're ignored. | Expecting unrelated Tasks to run because they're defined. | By design |

### Edges

| # | Law | ✅ Allowed | ❌ Not allowed | Enforced by |
| --- | --- | --- | --- | --- |
| E1 | `Flow.After` is the only way to create an edge. It points from the dependency to the dependent. | Any number of `After`s in one body. | Ordering Tasks any other way, e.g. by the order they're defined. | By design |
| E2 | `After`'s input must match the upstream Task's input type. | Omitting the input when the upstream Task's input accepts `undefined`. | Passing a `number` to a Task that takes `string[]`. | Type error |
| E3 | The graph is acyclic. | Diamonds: two Tasks depending on a shared third. | A Task that depends on itself, directly or through other Tasks. | Plan error |
| E4 | Repeating the same `After` in one body adds one edge. | Declaring the same dependency twice. | — | By design |
| E5 | `After` edges are fixed once planning ends. Nodes added during `run` come only from declared calls (C1). | Choosing dependencies from the Task's own input. | Adding dependencies during `run` (type error), or choosing them from an upstream Task's output (see O2). | Type error / run failure |

### Outputs

| # | Law | ✅ Allowed | ❌ Not allowed | Enforced by |
| --- | --- | --- | --- | --- |
| O1 | An upstream output is read with `yield* handle.output`, where the handle came from `Flow.After`. | Reading the same output more than once. | Reading an output from a Task you didn't declare with `After`, even one further upstream. | By design |
| O2 | Upstream outputs are only readable inside `run`. | — | Reading `handle.output` in the Task body during planning. This fails as a defect (a crash), not as a typed error. | Run failure |
| O3 | Every output is checked against the Task's output schema. | — | A `run` that produces a value that fails its schema at runtime. | Run failure |
| O4 | `Flow.run` returns the root Task's output. | Running the same plan several times; each run starts with no outputs. | Expecting outputs to carry over from one run to the next. | By design |

### Execution

| # | Law | ✅ Allowed | ❌ Not allowed | Enforced by |
| --- | --- | --- | --- | --- |
| X1 | A node starts only after all of its dependencies have succeeded. | — | A dependent starting before its dependency finishes. | By design |
| X2 | Nodes that don't depend on each other run at the same time, with no limit. | — | Relying on the order of unrelated nodes. | Convention |
| X3 | Each node runs at most once per run. | — | — | By design |
| X4 | The first failure of a planned node fails the whole run. Running nodes are interrupted, and nodes that depend on the failed one never start. A called node's failure goes to its caller instead (C5). | Handling errors inside `run` to recover locally. | Expecting other branches to keep going after a failure. | Run failure |
| X5 | A run fails with the failing Task's own error. | — | — | Run failure |

### Calls

| # | Law | ✅ Allowed | ❌ Not allowed | Enforced by |
| --- | --- | --- | --- | --- |
| C1 | A node can only call Tasks its body declared with `Flow.Calls`; the declaration returns the only way to call them. | Declaring a Task you may never call. | Calling a Task you didn't declare. | By design |
| C2 | The plan records each declaration (Task and `max`) but plans no node for it, since the input is only known at run time. | Reading `node.calls` and the dashed edges in `toMermaid`. | Expecting called nodes, or their dependencies, in the plan. | By design |
| C3 | Calls are only made inside `run`. | — | Calling during planning. This fails as a defect (a crash). | Run failure |
| C4 | A call plans its node then (running its body and `After`s), runs it, and returns its output. A key that already finished or is running in this run is reused. | Calling with the same input again; it runs once. | Expecting a repeated call to run again. | By design |
| C5 | A failed call fails its caller with the called Task's error, which the caller may handle. | `catchTag` on a call to retry or fall back. | — | Type error |
| C6 | A node makes at most `max` calls through one declaration per run, counting reused keys. More fail with `CallError` (`"limit"`). | Omitting `max` for no cap. | — | Run failure |
| C7 | A call that would wait on its caller, through dependencies or calls in flight, fails with `CallError` (`"cycle"`) instead of hanging. | — | — | Run failure |
| C8 | A call's errors and services are the called Task's, so they reach the caller's type through `run`. | — | Running a plan without a service a called Task needs. | Type error |

### Inputs

| # | Law | ✅ Allowed | ❌ Not allowed | Enforced by |
| --- | --- | --- | --- | --- |
| I1 | An Input is a Task with `kind: "input"`. Its input is what a person is shown; its output is their response. `After` and `Calls` accept it like any Task. | Planning an Input with `After` when the request is known at plan time, or calling it when it depends on results. | — | By design |
| I2 | Plan nodes and declared calls record their `kind`; `toMermaid` draws Inputs as hexagons. | — | — | By design |
| I3 | `run` answers an Input from `responses[key]`, decoded with its output schema's JSON codec. It never runs work for an Input. A response that fails the schema leaves the Input pending, with the reason in `rejected`. | Answering any Input the run will reach, in advance. | — | By design |
| I4 | Reaching an Input with no response fails the run with `Suspended`, listing each pending key, its name, description and request. This holds even if a caller handled the Input's failure. | Running again with the responses so far plus new ones. | Treating a handled `Suspended` as an answer. | Run failure |
| I5 | Responses are matched by key, so a run that is replayed with responses must reach the same Inputs with the same requests. | Branching on outputs of nodes, including Inputs. | Branching on the clock or randomness in `run`, so a replay asks something different. | Convention |

### Durable runs

| # | Law | ✅ Allowed | ❌ Not allowed | Enforced by |
| --- | --- | --- | --- | --- |
| D1 | `start` plans the root, records a run (Task name, JSON-encoded input, plan fingerprint) and runs it. `start` and `resume` return an `Outcome`: `Succeeded`, `Suspended` or `Failed`, each with the run id. | — | — | By design |
| D2 | A node whose output is stored for the run never runs again; the stored output is decoded with its schema's JSON codec. | — | Expecting a finished node to run again on resume. | By design |
| D3 | Failures aren't stored as outputs. Resuming a failed run runs failed nodes again, and a node cut off mid-work (stored as `running`) runs again too. | Resuming after fixing what failed. | Relying on a node's work running exactly once; it runs at least once. | By design |
| D4 | `resume` only accepts responses for the run's pending Inputs, and records them before running. Responding and continuing are one step. | Replacing a rejected response. | Answering an Input the run isn't waiting for (`ResumeError` `"unexpected-response"`). | Run failure |
| D5 | `resume` refuses a different Task name (`"task-mismatch"`), an unknown run (`"not-found"`), or a plan whose fingerprint differs from the one recorded at start (`"plan-changed"`). Called nodes aren't part of the fingerprint. | Changing what a called node does; its key changes, so it runs fresh. | Resuming a run after changing its static plan. | Run failure |
| D6 | Resuming a succeeded run returns its stored output without running anything. | — | — | By design |
| D7 | Outputs, inputs and responses are stored through their schemas' JSON codecs, so a store only needs to keep JSON. | Schemas whose type isn't JSON, such as `DateTimeUtcFromString`. | Schemas without a JSON form. | Run failure |

### Types

| # | Law | ✅ Allowed | ❌ Not allowed | Enforced by |
| --- | --- | --- | --- | --- |
| Y1 | A Task's errors include the errors of every Task it runs after, directly or indirectly. | — | Treating a Task as unable to fail when something upstream can fail. | Type error |
| Y2 | A Task's services include the services of every Task it runs after, directly or indirectly. | Providing those services once, around `plan` and `run`. | Running a plan without providing a service some upstream Task needs. | Type error |
| Y3 | `Flow.plan` needs the same services as `Flow.run`, because Task bodies run during planning. | — | Planning in an environment that's missing services the Tasks need. | Type error |

## Known gaps

These are places where the code allows something the laws forbid:

- **N4:** Tasks with the same name aren't detected. When their inputs also match, the second Task is silently merged into the first.
- **T4:** Nothing stops a Task body from causing side effects during planning.
- **O2:** Reading an upstream output during planning type-checks, then fails as a defect (a crash) rather than a typed `PlanError`.
- **X2:** There's no limit on how many nodes run at once.
- **C4:** A called node runs with the services of the first caller to reach it; later callers with the same key get its output even if they provided different services around the call.
- **C6:** Without `max` there is no cap. There's no limit on calls per run as a whole.
- **C7:** The cycle check runs after the called node has started, so a node in a detected cycle stays blocked until the run ends, even when its caller recovers from the `CallError`.
- **Y2:** Wrapping `Flow.After` in `Effect.provide*` removes the upstream Task's services from the type without giving them to its node, which then fails at run time with "Service not found".
- **I4:** A run stops at the first Input without a response. Other branches are interrupted (X4), so their Inputs only show up on a later run. With `Flow.run`, running again repeats all the work before the stop; with `Flow.start` and `resume`, only unfinished work runs again.
- **D3:** Two processes can resume the same run at once; nothing gives a run a single owner yet.
- **D7:** Only the in-memory store exists; nothing survives the process yet.
- **Run record:** Called nodes appear only in spans (`flow.caller` names the caller); `Flow.run` doesn't return the graph of what actually ran.

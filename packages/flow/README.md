# @effectory/flow

A spike on building DAG workflows with Effect. You define Tasks, `Flow.plan` turns a root Task into a graph, and `Flow.run` executes that graph.

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

## The two phases

Every Task has two halves, and they run at different times.

| Phase | What runs | What it may do |
| --- | --- | --- |
| **Plan** | The Task body (the function given to `Task`) | Declare dependencies with `Flow.After`, then return `{ run }`. |
| **Run** | The `run` Effect the body returned | Do the actual work and read the outputs of the Tasks it runs after. |

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
| N1 | A node is a Task applied to one input. Its key is the Task name plus the encoded input, e.g. `RunTests(["effect"])`. | One Task appearing as several nodes with different inputs. | — | — |
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
| E5 | Edges are fixed once planning ends. | Choosing dependencies from the Task's own input. | Adding dependencies during `run` (type error), or choosing them from an upstream Task's output (see O2). | Type error / run failure |

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
| X4 | The first failure fails the whole run. Running nodes are interrupted, and nodes that depend on the failed one never start. | Handling errors inside `run` to recover locally. | Expecting other branches to keep going after a failure. | Run failure |
| X5 | A run fails with the failing Task's own error. | — | — | Run failure |

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

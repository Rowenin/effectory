/**
 * A DAG workflow spike on Effect.
 *
 * A Task body runs at plan time: it declares upstream Tasks with `After`,
 * Tasks it may call at run time with `Calls`, and returns a `run` Effect. `plan` walks those declarations into an
 * `effect/Graph` DAG; `run` executes each node on its own fiber once every
 * upstream node has finished.
 */
// oxlint-disable-next-line no-barrel-file -- the public `Flow` namespace.
export { After, type Upstream } from "./after.ts";
export { Calls, type Call, type CallOptions } from "./calls.ts";
export {
  CallError,
  PlanError,
  StoreError,
  Suspended,
  type PendingInput,
} from "./errors.ts";
export { Input } from "./input.ts";
export {
  resume,
  start,
  status,
  ResumeError,
  type Outcome,
  type ResumeOptions,
  type RunState,
} from "./durable.ts";
export {
  layerMemory as memoryStore,
  RunStore,
  type NodeRecord,
  type NodeStatus,
  type RunRecord,
  type RunStatus,
} from "./store.ts";
export {
  fingerprint,
  plan,
  toMermaid,
  type Plan,
  type PlannedNode,
  type PlanNode,
} from "./plan.ts";
export { run, type RunOptions } from "./run.ts";
export { Planner } from "./services.ts";
export {
  Task,
  type AnySchema,
  type AnyTask,
  type ErrorOf,
  type InputArgs,
  type InputOf,
  type OutputOf,
  type ServicesOf,
  type Step,
  type TaskConfig,
  type TaskKind,
} from "./task.ts";

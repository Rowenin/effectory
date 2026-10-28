/**
 * A DAG workflow spike on Effect.
 *
 * A Task body runs at plan time: it declares upstream Tasks with `After` and
 * returns a `run` Effect. `plan` walks those declarations into an
 * `effect/Graph` DAG; `run` executes each node on its own fiber once every
 * upstream node has finished.
 */
// oxlint-disable-next-line no-barrel-file -- the public `Flow` namespace.
export { After, type Upstream } from "./after.ts";
export { PlanError } from "./errors.ts";
export {
  plan,
  toMermaid,
  type Plan,
  type PlannedNode,
  type PlanNode,
} from "./plan.ts";
export { run } from "./run.ts";
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
} from "./task.ts";

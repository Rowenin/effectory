// Public host API; automation definitions depend on the SDK instead.
/* oxlint-disable no-barrel-file */
export { startRuntime } from "./runtime.ts";
export { initializeWorkspace } from "./workspace.ts";
export { requestControl, RuntimeClientError } from "./client.ts";
export { openEngine } from "./engine.ts";
export type { LocalEngine, SubmitRun, DecideApproval } from "./engine.ts";
export {
  loadTaskCatalog,
  listTaskDirectories,
  loadWorkspaceConfig,
} from "./tasks.ts";
export type { RegisteredTask } from "./task.ts";

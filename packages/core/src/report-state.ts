import type { HistoryService, Target } from "./report-history.ts";
import { unavailableHistory } from "./report-history.ts";

/** Shared by SDK task definitions, the host and the test harness. Never serialized. */
const histories = new WeakMap<object, HistoryService>();
export const bindHistory = (runtime: object, history: HistoryService) => {
  histories.set(runtime, history);
};
export const historyFor = (runtime: object): HistoryService =>
  histories.get(runtime) ?? unavailableHistory;
export const sources = new WeakMap<object, Target>();
export const sourceSchemas = new WeakMap<object, object>();
export const results = new WeakSet<object>();
export const attachments = new WeakSet<object>();
export const targetKey = (target: Target): object =>
  target.kind === "Task" ? target.spec : target;

import type { Thread } from "@effectory/t3";

export const runId = "run:thread:thread-1:ordinal:2";

export const summary = (
  overrides: Partial<typeof Thread.ThreadSummary.Type> = {}
): typeof Thread.ThreadSummary.Type => ({
  createdAt: "2026-10-22T13:23:40.156Z",
  interactionMode: "default",
  latestRunId: runId,
  model: "claude-haiku-5-5",
  providerInstanceId: "claudeAgent",
  runtimeMode: "full-access",
  status: "running",
  threadId: "thread-1",
  title: "[effectory] review",
  updatedAt: "2026-10-22T13:23:43.528Z",
  ...overrides,
});

export const detail = (
  overrides: Partial<typeof Thread.ThreadDetail.Type.thread> = {},
  messages: typeof Thread.ThreadDetail.Type.messages = []
): typeof Thread.ThreadDetail.Type => {
  const status = overrides.status ?? "running";
  const latestRunId =
    overrides.latestRunId === undefined ? runId : overrides.latestRunId;
  return {
    messages,
    thread: {
      ...summary({ latestRunId, status }),
      activeRunId: [
        "preparing",
        "queued",
        "starting",
        "running",
        "waiting",
      ].includes(status)
        ? latestRunId
        : null,
      branch: null,
      pendingRequestCount: 0,
      projectId: "project-1",
      worktreePath: null,
      ...overrides,
    },
  };
};

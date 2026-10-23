import { Schema } from "effect";

// Decode only the fields Effectory relies on; T3 nightlies add fields freely.
// Statuses stay open strings so a new T3 status does not break decoding.

/** A thread as reported by `t3 thread list`. */
export const ThreadSummary = Schema.Struct({
  createdAt: Schema.String,
  interactionMode: Schema.String,
  latestRunId: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(Schema.String),
  runtimeMode: Schema.String,
  status: Schema.String,
  threadId: Schema.String,
  title: Schema.String,
  updatedAt: Schema.String,
});

export const ThreadMessage = Schema.Struct({
  role: Schema.String,
  runId: Schema.NullOr(Schema.String),
  text: Schema.String,
});

/** A thread and its latest messages as reported by `t3 thread show`. */
export const ThreadDetail = Schema.Struct({
  messages: Schema.Array(ThreadMessage),
  thread: Schema.Struct({
    ...ThreadSummary.fields,
    activeRunId: Schema.NullOr(Schema.String),
    branch: Schema.NullOr(Schema.String),
    pendingRequestCount: Schema.Int,
    projectId: Schema.String,
    worktreePath: Schema.NullOr(Schema.String),
  }),
});

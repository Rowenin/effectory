/* Context tags for the two task capabilities are kept together for safe task imports. */
/* eslint-disable max-classes-per-file */
import { Context } from "effect";
import type { Effect } from "effect";
import type {
  WorkflowEngine,
  WorkflowInstance,
} from "effect/workflow/WorkflowEngine";

import type { RuntimeError } from "./errors.ts";
import type { ApprovalDecision, ArtifactRecord } from "./records.ts";

export class Artifacts extends Context.Service<
  Artifacts,
  {
    readonly workspace: string;
    readonly publish: (options: {
      name: string;
      value: unknown;
      schemaVersion?: number;
    }) => Effect.Effect<ArtifactRecord, RuntimeError, WorkflowInstance>;
  }
>()("effectory/Artifacts") {}
export class Approval extends Context.Service<
  Approval,
  {
    readonly request: (options: {
      key: string;
      title: string;
      review: unknown;
    }) => Effect.Effect<
      ApprovalDecision,
      RuntimeError,
      WorkflowInstance | WorkflowEngine
    >;
  }
>()("effectory/Approval") {}

export type {
  ApprovalDecision,
  ApprovalRecord,
  ArtifactRecord,
  RunRecord,
} from "./records.ts";

export { RuntimeError } from "./errors.ts";

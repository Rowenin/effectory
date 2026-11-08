import { Schema } from "effect";

import { decode, identifier, version } from "./boundary.ts";
import type { Boundary } from "./boundary.ts";
import { DefinitionError } from "./errors.ts";
import { boundedInteger, durationMillis } from "./policy.ts";
import { Source, Status } from "./report-history.ts";
import type { KindOf, Target } from "./report-history.ts";
import {
  attachments,
  results,
  sources,
  sourceSchemas,
  targetKey,
} from "./report-state.ts";
import { normalize } from "./tag-state.ts";
import type * as Tag from "./tag.ts";
import type * as Task from "./task.ts";
import type * as Workflow from "./workflow.ts";

export type { Selection } from "./report-selection.ts";
export { RecordStatus, SourceIdentity } from "./report-record.ts";

export {
  Event,
  EventPage,
  History,
  InvocationItem,
  InvocationPage,
  Outcome,
  PathPreview,
  Source,
  Status,
} from "./report-history.ts";
export type { HistoryService, PageRequest, Target } from "./report-history.ts";

declare const sourceIdentity: unique symbol;
export interface SourceOf<
  Id extends string,
  V extends number,
  K extends "task" | "workflow",
> extends Schema.Codec<
  Source & {
    readonly targetId: Id;
    readonly targetVersion: V;
    readonly targetKind: K;
  },
  typeof Source.Encoded
> {
  readonly [sourceIdentity]: {
    readonly id: Id;
    readonly version: V;
    readonly kind: K;
  };
}

export function sourceOf<T extends Target>(
  target: T
): SourceOf<T["spec"]["id"], T["spec"]["version"], KindOf<T>> {
  identifier(target.id);
  version(target.spec.version);
  const key = targetKey(target);
  let schema = sourceSchemas.get(key);
  if (!schema) {
    schema = Schema.Struct({
      ...Source.fields,
      targetId: Schema.Literal(target.id),
      targetKind: Schema.Literal(target.kind === "Task" ? "task" : "workflow"),
      targetVersion: Schema.Literal(target.spec.version),
    });
    sources.set(schema, target);
    sourceSchemas.set(key, schema);
  }
  // The phantom identity is checked through the private schema registry at runtime.
  return schema as SourceOf<T["spec"]["id"], T["spec"]["version"], KindOf<T>>;
}

export function result<D extends Boundary>(data: D) {
  const schema = Schema.Struct({
    data,
    markdown: Schema.String.check(
      Schema.makeFilter(
        (text) => new TextEncoder().encode(text).byteLength <= 262_144
      )
    ),
  });
  results.add(schema);
  return schema;
}

type ErrorTags<E> = E extends { readonly _tag: infer T extends string }
  ? T
  : never;
export interface ExecutionPolicy<E = unknown> {
  readonly timeout?: string;
  readonly attemptTimeout?: string;
  readonly retry?: {
    readonly attempts: number;
    readonly delay: string;
    readonly when: readonly ErrorTags<E>[];
  };
}
export interface ResolvedExecution {
  readonly timeout: string;
  readonly attemptTimeout: string;
  readonly retry?: {
    readonly attempts: number;
    readonly delay: string;
    readonly when: readonly string[];
  };
}
export interface Attachment<
  T extends Target = Target,
  S extends Task.Spec = Task.Spec,
> {
  readonly tags: Readonly<Record<string, string>>;
  readonly required: boolean;
  readonly kind: "ReportAttachment";
  readonly id: string;
  readonly target: T;
  readonly task: Task.Contract<S>;
  readonly scope: "run" | "invocation";
  readonly on: readonly Status[];
  readonly execution: ResolvedExecution;
}

type Compatible<
  T extends Target,
  S extends Task.Spec,
> = S["success"]["Type"] extends {
  readonly markdown: string;
  readonly data: unknown;
}
  ? S["input"] extends SourceOf<infer I, infer V, infer K>
    ? [I, V, K] extends [T["spec"]["id"], T["spec"]["version"], KindOf<T>]
      ? [T["spec"]["id"], T["spec"]["version"], KindOf<T>] extends [I, V, K]
        ? unknown
        : { readonly incompatibleReportTarget: never }
      : { readonly incompatibleReportTarget: never }
    : S["input"] extends typeof Source
      ? unknown
      : { readonly invalidReportInput: never }
  : { readonly invalidReportResult: never };

function resolveExecution<E>(
  policy: ExecutionPolicy<E> | undefined
): ResolvedExecution {
  const timeout = policy?.timeout ?? "5 minutes";
  const attemptTimeout = policy?.attemptTimeout ?? "30 seconds";
  durationMillis(timeout);
  durationMillis(attemptTimeout);
  const retry = policy?.retry;
  if (retry) {
    boundedInteger(retry.attempts, 10, "Report retry attempts");
    boundedInteger(retry.when.length, 32, "Report retry tags");
    durationMillis(retry.delay);
    if (
      retry.when.length === 0 ||
      new Set(retry.when).size !== retry.when.length ||
      retry.when.some(
        (tag) => typeof tag !== "string" || tag.length === 0 || tag.length > 200
      )
    ) {
      throw new DefinitionError({
        message: "Report retry tags must be nonempty and unique",
      });
    }
  }
  return Object.freeze({
    attemptTimeout,
    timeout,
    ...(retry
      ? {
          retry: Object.freeze({
            ...retry,
            when: Object.freeze([...retry.when]),
          }),
        }
      : {}),
  });
}

function attachmentMetadata(options: {
  readonly tags?: Tag.Input;
  readonly required?: boolean;
}) {
  if ("required" in options && typeof options.required !== "boolean") {
    throw new DefinitionError({ message: "Report required must be a boolean" });
  }
  return {
    required: options.required ?? false,
    tags: normalize("tags" in options ? options.tags : {}),
  };
}

export function make<T extends Target, const S extends Task.Spec>(
  options: {
    readonly id: string;
    readonly target: T;
    readonly task: Task.Contract<S> & NoInfer<Compatible<T, S>>;
    readonly tags?: Tag.Input;
    readonly required?: boolean;
    readonly on?: readonly Status[];
    readonly execution?: ExecutionPolicy<S["error"]["Type"]>;
  } & (T extends Workflow.Definition
    ? { readonly scope?: "run" | "invocation" }
    : { readonly scope: "run" | "invocation" })
): Attachment<T, S> {
  const id = identifier(options.id);
  const { tags, required } = attachmentMetadata(options);
  if (options.execution?.retry && options.task.spec.replay !== "idempotent") {
    throw new DefinitionError({
      message: "Report retries require idempotent replay",
    });
  }
  const scope =
    options.scope ?? (options.target.kind === "Task" ? undefined : "run");
  if (scope !== "run" && scope !== "invocation") {
    throw new DefinitionError({
      message:
        "Report scope must be run or invocation, and explicit for a task",
    });
  }
  const sourceTarget = sources.get(options.task.inputSchema);
  if (
    options.task.inputSchema !== Source &&
    (!sourceTarget || targetKey(sourceTarget) !== targetKey(options.target))
  ) {
    throw new DefinitionError({
      message:
        "Reporter input must use Report.Source or Report.sourceOf its canonical target",
    });
  }
  if (!results.has(options.task.successSchema)) {
    throw new DefinitionError({
      message: "Reporter success must use Report.result",
    });
  }
  const on = options.on ?? [
    "Succeeded",
    "Failed",
    "Rejected",
    "TimedOut",
    "Cancelled",
  ];
  try {
    decode(
      Schema.Array(Status).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
      on
    );
  } catch {
    throw new DefinitionError({
      message: "Report on must contain terminal source statuses",
    });
  }
  if (new Set(on).size !== on.length) {
    throw new DefinitionError({ message: "Duplicate report outcome filter" });
  }
  const attachment: Attachment<T, S> = Object.freeze({
    execution: resolveExecution(options.execution),
    id,
    kind: "ReportAttachment",
    on: Object.freeze([...on]),
    required,
    scope,
    tags,
    target: options.target,
    task: options.task,
  });
  attachments.add(attachment);
  return attachment;
}

export { test } from "./report-test.ts";

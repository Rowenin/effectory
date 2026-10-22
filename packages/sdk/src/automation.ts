import type { BunServices } from "@effect/platform-bun/BunServices";
import { Effect, Schema } from "effect";
import type { Scope } from "effect";
import type { HttpClient } from "effect/http/HttpClient";
import * as NativeActivity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";
import type {
  WorkflowInstance,
  WorkflowEngine,
} from "effect/workflow/WorkflowEngine";

import type { ArtifactStore } from "./artifact-store.ts";
import { AutomationError, requireName } from "./authoring.ts";
import type { Codec } from "./authoring.ts";
import { Approval, Artifacts } from "./services.ts";

/** Services supplied by the local host. Configuration supplies application services. */
export type HostServices =
  | BunServices
  | HttpClient
  | Approval
  | Artifacts
  | ArtifactStore
  | WorkflowEngine
  | WorkflowInstance
  | Scope.Scope;

/** A runnable automation backed by a native Workflow and registration Layer. */
export const define = <
  const Name extends string,
  I extends Codec & Workflow.AnyStructSchema,
  S extends Codec,
  E extends Codec,
  R,
>(options: {
  readonly name: Name;
  readonly description: string;
  readonly input: I;
  readonly success: S;
  readonly error: E;
  readonly idempotencyKey: (input: I["Type"]) => string;
  readonly execute: (
    input: I["Type"],
    runId: string
  ) => Effect.Effect<
    NoInfer<S["Type"]>,
    NoInfer<E["Type"]> | AutomationError,
    R
  >;
}) => {
  requireName(options.name);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(options.name)) {
    throw new Error("Automation names must use lowercase kebab-case");
  }
  if (!options.description.trim()) {
    throw new Error("Automation descriptions must not be empty");
  }
  const workflow = Workflow.make(options.name, {
    error: Schema.Union([options.error, AutomationError]),
    idempotencyKey: options.idempotencyKey,
    payload: options.input,
    success: options.success,
  });
  return {
    description: options.description,
    implementation: workflow.toLayer((input, runId) =>
      Effect.suspend(() => options.execute(input, runId)).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(Schema.toType(options.success))(
            value
          ).pipe(
            Effect.mapError(
              (cause) =>
                new AutomationError({
                  message: String(cause),
                  operation: options.name,
                  reason: "invalid-output",
                })
            )
          )
        )
      )
    ),
    name: options.name,
    workflow,
  };
};

/** Publish a schema-encoded JSON artifact behind its own durable activity boundary. */
export const publish = <S extends Codec>(
  name: string,
  options: {
    readonly schema: S;
    readonly value: NoInfer<S["Type"]>;
    readonly schemaVersion?: number;
  }
) => {
  requireName(name);
  return NativeActivity.make({
    error: AutomationError,
    execute: Effect.gen(function* publishArtifact() {
      const value = yield* Schema.encodeEffect(
        Schema.toCodecJson(options.schema)
      )(options.value).pipe(
        Effect.mapError(
          (cause) =>
            new AutomationError({
              message: String(cause),
              operation: name,
              reason: "invalid-output",
            })
        )
      );
      const artifacts = yield* Artifacts;
      yield* artifacts
        .publish({
          name,
          value,
          ...(options.schemaVersion === undefined
            ? {}
            : { schemaVersion: options.schemaVersion }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AutomationError({
                message: cause.message,
                operation: name,
                reason: "runtime",
              })
          )
        );
    }),
    name: `effectory/output/${name}`,
  });
};

/** Suspend durably for review. Rejection fails the automation before subsequent effects. */
export const approve = (options: {
  readonly key: string;
  readonly title: string;
  readonly review: unknown;
}) =>
  Effect.gen(function* requestApproval() {
    const approval = yield* Approval;
    const decision = yield* approval.request(options).pipe(
      Effect.mapError(
        (cause) =>
          new AutomationError({
            message: cause.message,
            operation: options.key,
            reason: "runtime",
          })
      )
    );
    if (decision.outcome === "rejected") {
      return yield* new AutomationError({
        message: decision.reason ?? "Approval rejected",
        operation: options.key,
        reason: "approval-rejected",
      });
    }
    return { ...decision, outcome: "approved" as const };
  });

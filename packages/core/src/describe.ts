/**
 * The agent discovery surface: every workflow, Action, Resource type,
 * Target, and Trigger of a collection, with JSON Schemas for their inputs
 * and outputs. Backs `effectory describe --json`.
 */
import { Schema } from "effect";

import type * as Collection from "./collection.ts";
import type * as Trigger from "./trigger.ts";

/** A JSON Schema (draft 2020-12) document. */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface WorkflowDescription {
  readonly name: string;
  readonly description: string;
  readonly input: JsonSchema;
}

export interface ActionDescription {
  readonly type: string;
  readonly description: string;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
  readonly rerun: "always" | "on-change";
  readonly retry: "auto" | "never";
}

export interface ResourceDescription {
  readonly type: string;
  readonly description: string;
  readonly props: JsonSchema;
  readonly attributes: JsonSchema;
}

export interface TargetDescription {
  readonly name: string;
  readonly workflow: string;
  readonly description: string;
  readonly version: string;
  /** The encoded input preset. */
  readonly input: Readonly<Record<string, unknown>>;
}

export type TriggerDescription =
  | {
      readonly kind: "schedule";
      readonly name: string;
      readonly workflow: string;
      readonly target?: string;
      readonly cron: string;
    }
  | {
      readonly kind: "webhook";
      readonly name: string;
      readonly workflow: string;
      readonly target?: string;
      readonly route: string;
      readonly verified: boolean;
    };

export interface Description {
  readonly name: string;
  readonly description: string;
  readonly workflows: readonly WorkflowDescription[];
  readonly actions: readonly ActionDescription[];
  readonly resources: readonly ResourceDescription[];
  readonly targets: readonly TargetDescription[];
  readonly triggers: readonly TriggerDescription[];
}

const dialect = "https://json-schema.org/draft/2020-12/schema";

/**
 * A standalone JSON Schema for the JSON form of `schema` (what the CLI and
 * State accept and store), with definitions under `$defs`.
 */
export const jsonSchema = (schema: Schema.Top): JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema);
  const definitions = Object.keys(document.definitions).length > 0;
  return {
    $schema: dialect,
    ...document.schema,
    ...(definitions ? { $defs: document.definitions } : {}),
  };
};

const targetOf = (trigger: Trigger.Trigger) =>
  trigger.target === undefined ? {} : { target: trigger.target.name };

const describeTrigger = (trigger: Trigger.Trigger): TriggerDescription =>
  trigger._tag === "Schedule"
    ? {
        cron: trigger.cron,
        kind: "schedule",
        name: trigger.name,
        workflow: trigger.workflow.name,
        ...targetOf(trigger),
      }
    : {
        kind: "webhook",
        name: trigger.name,
        route: trigger.route,
        verified: trigger.verify !== undefined,
        workflow: trigger.workflow.name,
        ...targetOf(trigger),
      };

/** Describe a collection with JSON Schemas. */
export const describe = (collection: Collection.Any): Description => ({
  actions: collection.actions.map((action) => ({
    description: action.definition.description ?? "",
    input: jsonSchema(action.definition.input),
    output: jsonSchema(action.definition.output),
    rerun: action.definition.rerun ?? "always",
    retry: action.definition.retry ?? "auto",
    type: action.type,
  })),
  description: collection.description,
  name: collection.name,
  resources: collection.resources.map((resource) => ({
    attributes: jsonSchema(resource.attributes),
    description: resource.description ?? "",
    props: jsonSchema(resource.props),
    type: resource.type,
  })),
  targets: collection.targets.map((target) => ({
    description: target.description,
    input: target.input,
    name: target.name,
    version: target.version,
    workflow: target.workflow.name,
  })),
  triggers: collection.triggers.map(describeTrigger),
  workflows: collection.workflows.map((workflow) => ({
    description: workflow.description,
    input: jsonSchema(workflow.input),
    name: workflow.name,
  })),
});

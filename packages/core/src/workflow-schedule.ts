import { Cron, Schema } from "effect";

import { checkJsonBudget, decode, identifier } from "./boundary.ts";
import { checkSettings } from "./check-schema.ts";
import type { CheckOptions, CheckSettings } from "./check-schema.ts";
import { DefinitionError } from "./errors.ts";
import { durationMillis } from "./policy.ts";
import type { EncodedSelection } from "./report-selection-schema.ts";
import { authorSelection } from "./report-selection.ts";
import type { Selection } from "./report-selection.ts";
import { normalize, snapshot, validate } from "./tag-state.ts";
import type * as Tag from "./tag.ts";
import type * as Workflow from "./workflow.ts";

export type CatchUp = "skip" | { readonly latestWithin: string };
export interface Definition<S extends Workflow.Spec = Workflow.Spec> {
  readonly checks: typeof CheckSettings.Type;
  readonly tags: Readonly<Record<string, string>>;
  readonly reportSelection: typeof EncodedSelection.Type;
  readonly kind: "WorkflowSchedule";
  readonly id: string;
  readonly workflow: Workflow.Definition<S>;
  readonly encodedInput: Schema.Json;
  readonly cron: string;
  readonly timeZone: string;
  readonly catchUp: CatchUp;
  readonly description?: string;
}

function freezeJson(value: Schema.Json): Schema.Json {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}

function validateCron(cron: string, zone: string | undefined) {
  const expression = cron.trim().replaceAll(/\s+/gu, " ");
  if (expression.startsWith("@")) {
    throw new Error(
      "Cron nicknames are unsupported; use a five-field expression"
    );
  }
  if (expression.split(" ").length !== 5) {
    throw new Error(
      "Cron requires five fields; seconds fields are unsupported"
    );
  }
  const modifiers = expression
    .replaceAll(
      /JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT/giu,
      ""
    )
    .match(/[L W#?]/giu)
    ?.filter((value) => value !== " ");
  if (modifiers?.length) {
    throw new Error(`Unsupported cron modifier: ${modifiers[0]}`);
  }
  const timeZone = zone ?? "UTC";
  if (/^[+-]/u.test(timeZone)) {
    throw new Error("Use a named IANA time zone or UTC, not a numeric offset");
  }
  new Intl.DateTimeFormat("en", { timeZone }).format(0);
  const parsed = Cron.parseUnsafe(expression, timeZone);
  Cron.next(parsed, "2000-01-01T00:00:00.000Z");
  return { expression, timeZone };
}

export function make<const S extends Workflow.Spec>(spec: {
  readonly checks?: typeof CheckOptions.Type;
  readonly tags?: Tag.Input;
  readonly reportSelection?: Selection;
  readonly id: string;
  readonly workflow: Workflow.Definition<S>;
  readonly input: NoInfer<S["input"]["Type"]>;
  readonly cron: string;
  readonly timeZone?: string;
  readonly catchUp?: CatchUp;
  readonly description?: string;
}): Definition<S> {
  try {
    const allowed = new Set([
      "checks",
      "tags",
      "reportSelection",
      "id",
      "workflow",
      "input",
      "cron",
      "timeZone",
      "catchUp",
      "description",
    ]);
    if (Object.keys(spec).some((key) => !allowed.has(key))) {
      throw new Error("Unsupported schedule option");
    }
    const id = identifier(spec.id);
    const checks = checkSettings("checks" in spec ? spec.checks : {});
    const reportSelection = authorSelection(
      "reportSelection" in spec ? spec.reportSelection : {}
    );
    const tags = normalize("tags" in spec ? spec.tags : {});
    validate(
      snapshot({ ...spec.workflow.tags, ...tags }),
      spec.workflow.tagSchemas
    );
    const { expression, timeZone } = validateCron(spec.cron, spec.timeZone);
    const catchUp = spec.catchUp ?? "skip";
    if (catchUp !== "skip") {
      if (
        Object.keys(catchUp).length !== 1 ||
        !Object.hasOwn(catchUp, "latestWithin")
      ) {
        throw new Error("Invalid catch-up policy");
      }
      const window = durationMillis(catchUp.latestWithin);
      if (window < 60_000 || window > 31 * 86_400_000) {
        throw new Error("Catch-up window must be between 1 minute and 31 days");
      }
    }
    if (
      spec.description !== undefined &&
      (typeof spec.description !== "string" || spec.description.length > 8192)
    ) {
      throw new Error("Schedule description exceeds 8192 characters");
    }
    const encoded = Schema.encodeUnknownSync(spec.workflow.inputSchema)(
      spec.input,
      { onExcessProperty: "error" }
    );
    checkJsonBudget(encoded);
    const json = Schema.decodeUnknownSync(Schema.Json)(encoded);
    decode(spec.workflow.inputSchema, json);
    const copied = Schema.decodeUnknownSync(Schema.Json)(structuredClone(json));
    return Object.freeze({
      catchUp: catchUp === "skip" ? catchUp : Object.freeze({ ...catchUp }),
      checks,
      cron: expression,
      encodedInput: freezeJson(copied),
      id,
      kind: "WorkflowSchedule",
      reportSelection,
      tags,
      timeZone,
      workflow: spec.workflow,
      ...(spec.description === undefined
        ? {}
        : { description: spec.description }),
    });
  } catch (error) {
    throw new DefinitionError({
      message: `Invalid workflow schedule: ${error instanceof Error ? error.message : "invalid definition"}`,
    });
  }
}

export { Occurrence } from "./schedule-occurrence.ts";

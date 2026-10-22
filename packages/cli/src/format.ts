// Human-readable output for `effectory workflow list` and `describe`.

interface JsonSchema {
  readonly $ref?: string;
  readonly anyOf?: readonly JsonSchema[];
  readonly const?: unknown;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly items?: JsonSchema;
  readonly maxItems?: number;
  readonly maxLength?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly minLength?: number;
  readonly minimum?: number;
  readonly oneOf?: readonly JsonSchema[];
  readonly pattern?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly title?: string;
  readonly type?: string | readonly string[];
}

export interface WorkflowSummary {
  readonly name: string;
  readonly description: string;
}

export interface WorkflowDescription extends WorkflowSummary {
  readonly inputSchema: {
    readonly schema: JsonSchema;
    readonly definitions?: Readonly<Record<string, JsonSchema>>;
  };
  readonly revision: string;
}

type Definitions = Readonly<Record<string, JsonSchema>>;

const columns = (rows: readonly (readonly string[])[], gap = 2) => {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0))
  );
  return rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1
          ? cell
          : cell.padEnd((widths?.[column] ?? 0) + gap)
      )
      .join("")
      .trimEnd()
  );
};

const deref = (schema: JsonSchema, definitions: Definitions): JsonSchema => {
  if (schema.$ref === undefined) {
    return schema;
  }
  const name = schema.$ref.split("/").at(-1) ?? "";
  const target = definitions[name];
  return target === undefined ? schema : { title: name, ...target };
};

/** Non-null alternatives, and whether null is allowed. */
const variants = (schema: JsonSchema, definitions: Definitions) => {
  const options = schema.anyOf ?? schema.oneOf;
  if (options === undefined) {
    return { nullable: false, options: [schema] };
  }
  const resolved = options.map((option) => deref(option, definitions));
  const options_ = resolved.filter((option) => option.type !== "null");
  return { nullable: options_.length < resolved.length, options: options_ };
};

const literal = (value: unknown) =>
  typeof value === "string" ? `"${value}"` : JSON.stringify(value);

const label = (schema: JsonSchema, definitions: Definitions): string => {
  const resolved = deref(schema, definitions);
  const { nullable, options } = variants(resolved, definitions);
  if (options.length !== 1 || options[0] !== resolved) {
    const inner = options.map((option) => label(option, definitions));
    return [...inner, ...(nullable ? ["null"] : [])].join(" | ");
  }
  if (resolved.const !== undefined) {
    return literal(resolved.const);
  }
  if (resolved.enum !== undefined) {
    return resolved.enum.map(literal).join(" | ");
  }
  if (resolved.type === "array") {
    return `array of ${resolved.items ? label(resolved.items, definitions) : "any"}`;
  }
  if (Array.isArray(resolved.type)) {
    return resolved.type.join(" | ");
  }
  return resolved.title ?? (resolved.type as string | undefined) ?? "any";
};

const range = (min: number | undefined, max: number | undefined, unit = "") => {
  if (min !== undefined && max !== undefined) {
    return min === max ? `exactly ${min}${unit}` : `${min}–${max}${unit}`;
  }
  if (min !== undefined) {
    return `at least ${min}${unit}`;
  }
  return max === undefined ? undefined : `at most ${max}${unit}`;
};

const details = (schema: JsonSchema, definitions: Definitions) => {
  const { options } = variants(deref(schema, definitions), definitions);
  const [only] = options;
  const constraints =
    options.length === 1 && only !== undefined
      ? [
          range(only.minimum, only.maximum),
          range(only.minLength, only.maxLength, " chars"),
          range(only.minItems, only.maxItems, " items"),
          only.pattern === undefined ? undefined : `matches ${only.pattern}`,
        ]
      : [];
  const { description } = deref(schema, definitions);
  return [
    // Skip constraints the description already states.
    ...constraints.filter(
      (part) => part !== undefined && !description?.includes(part)
    ),
    ...(description === undefined ? [] : [description]),
  ].join("; ");
};

/** The object whose fields should be listed under a field, if any. */
const nested = (schema: JsonSchema, definitions: Definitions) => {
  const { options } = variants(deref(schema, definitions), definitions);
  const [only] = options;
  if (options.length !== 1 || only === undefined) {
    return;
  }
  const target =
    only.type === "array" && only.items ? deref(only.items, definitions) : only;
  return target.properties === undefined ? undefined : target;
};

const fieldRows = (
  schema: JsonSchema,
  definitions: Definitions,
  depth: number
): string[][] => {
  const required = new Set(schema.required);
  return Object.entries(schema.properties ?? {}).flatMap(([name, field]) => {
    const child = nested(field, definitions);
    return [
      [
        `${"  ".repeat(depth)}${name}`,
        label(field, definitions),
        required.has(name) ? "required" : "optional",
        details(field, definitions),
      ],
      ...(child === undefined ? [] : fieldRows(child, definitions, depth + 1)),
    ];
  });
};

/** `effectory workflow list`: one workflow per line. */
export const workflowList = (workflows: readonly WorkflowSummary[]) =>
  workflows.length === 0
    ? "No workflows registered. List them in effectory.run.ts."
    : columns([
        ["NAME", "DESCRIPTION"],
        ...workflows.map((workflow) => [workflow.name, workflow.description]),
      ]).join("\n");

/** `effectory workflow describe <name>`: what it does and the input it takes. */
export const workflowDescription = (workflow: WorkflowDescription) => {
  const definitions = workflow.inputSchema.definitions ?? {};
  const rows = fieldRows(
    deref(workflow.inputSchema.schema, definitions),
    definitions,
    0
  );
  return [
    workflow.name,
    workflow.description,
    "",
    "Input",
    ...(rows.length === 0
      ? ["  (none)"]
      : columns(rows).map((line) => `  ${line}`)),
    "",
    `Revision  ${workflow.revision.slice(0, 12)}`,
    `Run       effectory workflow run ${workflow.name} --input <file.json>`,
  ].join("\n");
};

import { DefinitionError } from "./errors.ts";
import { Source } from "./report-history.ts";
import { attachments, results, sources, targetKey } from "./report-state.ts";
import type { Attachment } from "./report.ts";
import type * as Task from "./task.ts";
import type * as Workflow from "./workflow.ts";

export function registerReports(
  declared: readonly Attachment[],
  tasks: ReadonlyMap<string, Task.Contract>,
  workflows: ReadonlyMap<string, { readonly definition: Workflow.Definition }>
) {
  if (declared.length > 128) {
    throw new DefinitionError({
      message: "Application exceeds 128 report attachments",
    });
  }
  const registered = new Map<string, Attachment>();
  const counts = new Map<object, Map<string, number>>();
  for (const attachment of declared) {
    if (!attachments.has(attachment)) {
      throw new DefinitionError({
        message:
          "Reports must be constructed with Report.make using the host SDK",
      });
    }
    if (registered.has(attachment.id)) {
      throw new DefinitionError({
        message: `Duplicate report attachment: ${attachment.id}`,
      });
    }
    const reporter = tasks.get(attachment.task.id);
    if (!reporter || reporter.spec !== attachment.task.spec) {
      throw new DefinitionError({
        message: `Missing or noncanonical reporter task: ${attachment.task.id}`,
      });
    }
    const { target } = attachment;
    const resolved =
      target.kind === "Task"
        ? tasks.get(target.id)
        : workflows.get(target.id)?.definition;
    if (!resolved || targetKey(resolved) !== targetKey(target)) {
      throw new DefinitionError({
        message: `Missing or noncanonical report target: ${target.id}`,
      });
    }
    const source = sources.get(reporter.inputSchema);
    if (
      (reporter.inputSchema !== Source &&
        (!source || targetKey(source) !== targetKey(target))) ||
      !results.has(reporter.successSchema)
    ) {
      throw new DefinitionError({
        message: `Reporter schemas changed after attachment: ${attachment.id}`,
      });
    }
    const key = targetKey(target);
    const scoped = counts.get(key) ?? new Map<string, number>();
    const count = (scoped.get(attachment.scope) ?? 0) + 1;
    if (count > 16) {
      throw new DefinitionError({
        message: `More than 16 reports for ${target.id}/${attachment.scope}`,
      });
    }
    scoped.set(attachment.scope, count);
    counts.set(key, scoped);
    registered.set(attachment.id, attachment);
  }
  return registered;
}

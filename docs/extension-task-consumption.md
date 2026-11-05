# Using extension tasks in your own workflows

The typed descriptor, local workflow composition, service requirements, binding generation and locked restore are now implemented and covered by a publication/typecheck fixture. Persisted GitHub add/update/remove operations and candidate activation are implemented; CLI integration uses fixture release responses. See [implementation status](implementation-status.md) for evidence; names in the design examples below remain illustrative.

## Install, import and compose

Installation generates an ordinary local TypeScript module. It exposes named, typed task contracts that work with `graph.task`:

```sh
effectory extension add github:acme/effectory-release-tools@v1.0.0 --as ReleaseTools --trust
```

```ts
import { Task, Workflow } from "@effectory/core";
// workflows/release-report.ts
import { Effect, Schema } from "effect";

import { ReleaseTools } from "../effectory.extensions";

const InspectRelease = ReleaseTools.tasks.InspectRelease;

// The illustrative extension task accepts { repository: string }
// and returns { version: string, notes: string }.
const FormatReport = Task.make(
  {
    id: "reports/format",
    version: 1,
    input: InspectRelease.successSchema,
    success: Schema.String,
    error: Schema.Never,
    replay: "idempotent",
  },
  ({ version, notes }) => Effect.succeed(`# ${version}\n\n${notes}`)
);

export const ReleaseReport = Workflow.make(
  {
    id: "release-report",
    version: 1,
    input: InspectRelease.inputSchema,
    success: FormatReport.successSchema,
    error: InspectRelease.errorSchema,
  },
  Effect.gen(function* () {
    const graph = yield* Workflow.Builder;
    const input = yield* graph.input(InspectRelease.inputSchema);
    const release = yield* graph.task("inspect", InspectRelease, input);
    return yield* graph.task("format", FormatReport, release);
  })
);

export const ReportTasks = [FormatReport];
```

Select the extension once alongside the local tasks and workflows:

```ts
// effectory.ts
import { Application, Extension } from "@effectory/core";

import { ReleaseTools } from "./effectory.extensions";
import { ReleaseServicesLive } from "./services";
import { ReleaseReport, ReportTasks } from "./workflows/release-report";

export default Application.make({
  tasks: ReportTasks,
  workflows: [ReleaseReport],
  extensions: [Extension.use(ReleaseTools)],
}).provide(ReleaseServicesLive);
```

An installed descriptor also exposes the contract entry's additional exports through `ReleaseTools.exports`, so service identities can be used directly in `Layer.succeed(ReleaseTools.exports.Client, implementation)` without importing a cache path.

`ReleaseServicesLive` supplies the hypothetical extension's required application services. Its typed descriptor must retain those requirements. An extension with no unsatisfied application service requirements needs no additional Layer.

`Extension.use(ReleaseTools)` registers the contributed task, so it does not also appear in `Application.tasks`. Any number of local workflows can import and use it; each invocation has its own node ID, input and execution state. An exported workflow composes similarly through `graph.workflow("child", ReleaseTools.workflows.SomeFlow, input)`.

## What the extension exports

Refine `Extension.make` to use named task exports:

```ts
export default Extension.make({
  id: "acme/release-tools",
  version: "1.0.0",
  tasks: { InspectRelease },
});
```

The record key is the public TypeScript export name. The task still has its own namespaced spec ID and contract version. The runtime never guesses export names from JavaScript variable names. Workflows and artifacts can use named records too. This changes the earlier extension task-array proposal; Application task arrays remain unchanged.

`ReleaseTools.tasks.InspectRelease` is a typed task contract carrying the actual input/success/error/output codecs, task/version identity and extension provenance. It has no callable implementation. `graph.task` accepts either this contract or a local task definition, resolving the handler from the application's selected contributions. Importing a contract does not execute its task or register a provider. An imported task whose extension is not selected causes graph validation to fail.

This avoids repeating schemas or writing an unsound string lookup such as `Extension.task<MyInput, MyOutput>("some-id")`. Static types come from the locked extension's declarations; runtime validation still uses its canonical codecs.

## Distribution and generated bindings

The extension archive must include a contract entry point and matching TypeScript declarations alongside its implementation entry point. Build tooling derives named exports from the extension declaration. Contract modules export the real codecs, including transformations; JSON Schema alone cannot reconstruct them. They must not import handlers or acquire resources, though they remain trusted executable code. Shared contract dependencies resolve canonically within a loaded revision.

Installation generates `effectory.extensions.ts` as a small facade over verified local contract modules and their types. It must work with ordinary TypeScript module resolution and editor autocomplete; no custom language-server resolver or separate npm publication is required. The generated descriptor exposes typed `tasks`, `workflows` and `artifacts`, plus provider identity and service requirements. Its emitted declaration retains selected implementation service requirements; additional contract exports are available through `.exports`.

`--as ReleaseTools` chooses a repository-local binding name, recorded with the extension configuration/lock. It does not rename extension or task IDs. Reject invalid/reserved identifiers and collisions before changing the generated facade. The flag is optional for installation without a typed source binding. Existing aliases survive updates; changing an alias is an explicit source-breaking change.

Generated files are disposable and must not be edited by consumers. The tracked lock/configuration and verified archive/cache reproduce them. Use `effectory extension restore --trust` on first restore for preparing locked packages and bindings on a fresh checkout before a standalone typecheck. Restore verifies recorded digests, never resolves newer refs, and does not select overrides. Implementations must not require importing the application just to restore its missing imports. Restore is a local bootstrap operation under the exclusive repository lock and refuses to run while the daemon owns that repository; it is intended for checkout setup before typechecking or starting the runtime.

Updates regenerate bindings, making removed exports and changed inputs visible to TypeScript. The loader also checks facade/contract digests against the candidate lock snapshot before activation. Publish a complete facade atomically and retain the old binding/contract snapshot with each running application revision. An update must not make an in-flight application compilation mix old types and new code. These are generation/activation requirements, not guarantees already demonstrated.

`Extension.use(id, selection?)` remains proposed for dynamic configuration; `Extension.use(ReleaseTools, selection?)` is the recommended typed authoring path. Selecting named replacements and patches continues to be explicit in either form.

## Required proof

Prototype installation to generated import to local workflow, including input, result, error, output and external service inference. Verify ordinary editor/tsc resolution, missing selection, named-export collisions, exact codec identity, fresh-checkout restore and update/compile races. Test that importing the contract does not import handler modules, and that existing runs retain their old modules. The executable fixture now covers emitted declarations, generated imports, canonical services/codecs, missing selection, offline restore and retained modules. Installation/update operation races remain to prove.

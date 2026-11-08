import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";

const root = path.resolve(
  import.meta.dir,
  "../packages/cli/assets/effectory-build"
);
const output = path.resolve(
  import.meta.dir,
  "../packages/cli/src/agent-assets.generated.json"
);
const files: Record<string, string> = {};
function visit(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted(
    (a, b) => a.name.localeCompare(b.name)
  )) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(filename);
    } else {
      files[path.relative(root, filename).split(path.sep).join("/")] =
        readFileSync(filename, "utf-8");
    }
  }
}
visit(root);
if (process.argv.includes("--check")) {
  const saved = Schema.decodeSync(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
  )(readFileSync(output, "utf-8"));
  const keys = Object.keys(files).toSorted();
  if (
    keys.length !== Object.keys(saved).length ||
    keys.some((key) => saved[key] !== files[key])
  ) {
    throw new Error(
      "Agent assets are stale; run bun scripts/generate-agent-assets.ts"
    );
  }
} else {
  writeFileSync(output, `${JSON.stringify(files, null, 2)}\n`);
}

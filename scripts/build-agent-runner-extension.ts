import path from "node:path";
import { parseArgs } from "node:util";

import { buildAgentRunnerExtension } from "../extensions/agent-runner/build.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    outdir: { default: "dist/extensions/agent-runner", type: "string" },
  },
});
const result = await buildAgentRunnerExtension(path.resolve(values.outdir));
process.stdout.write(
  `${JSON.stringify({ archive: result.archive, digest: result.digest, files: result.files })}\n`
);

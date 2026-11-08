import path from "node:path";
import { parseArgs } from "node:util";

import { buildAwsVaultExtension } from "../extensions/aws-vault/build.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { outdir: { default: "dist/extensions/aws-vault", type: "string" } },
});
const result = await buildAwsVaultExtension(path.resolve(values.outdir));
process.stdout.write(
  `${JSON.stringify({ archive: result.archive, digest: result.digest, files: result.files })}\n`
);

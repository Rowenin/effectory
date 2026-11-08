/* oxlint-disable no-await-in-loop -- Each executable proof uses the preceding proof artifacts. */
/** Real executable transition proofs. Never substitutes ABI labels or edits retained manifests. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    bootstrap: { type: "string" },
    breaking: { type: "string" },
    output: { type: "string" },
    previous: { type: "string" },
    target: { type: "string" },
  },
});
assert.ok(
  values.previous !== undefined &&
    values.previous !== "" &&
    values.target !== undefined &&
    values.target !== "" &&
    values.output !== undefined &&
    values.output !== "",
  "Usage: bun scripts/verify-runtime-upgrade.ts --previous OLD_BINARY --target NEW_BINARY --output NEW_EVIDENCE_DIRECTORY [--breaking INCOMPATIBLE_FIXTURE_BINARY]"
);
const previous = realpathSync(values.previous);
const target = realpathSync(values.target);
const digest = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const predecessorDigest = digest(previous);
const targetDigest = digest(target);
assert.notEqual(
  predecessorDigest,
  targetDigest,
  "Proof requires distinct executables"
);
const output = path.resolve(values.output);
mkdirSync(output, { mode: 0o700 });
const environment = {
  ...process.env,
  EFFECTORY_PREVIOUS_BINARY: previous,
  EFFECTORY_UPGRADE_BINARY: target,
  EFFECTORY_UPGRADE_PROOF_DIR: output,
  ...(values.bootstrap !== undefined && values.bootstrap !== ""
    ? { EFFECTORY_BOOTSTRAP_BINARY: realpathSync(values.bootstrap) }
    : {}),
  ...(values.breaking !== undefined && values.breaking !== ""
    ? { EFFECTORY_BREAKING_BINARY: realpathSync(values.breaking) }
    : {}),
};
const cases = [
  "wait-rollback",
  "lifecycle",
  "writers",
  ...(values.breaking !== undefined && values.breaking !== ""
    ? ["breaking"]
    : []),
];
for (const name of cases) {
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "upgrade-proof", `${name}.mjs`),
    ],
    {
      env: environment,
      stderr: Bun.file(path.join(output, `${name}.stderr.log`)),
      stdout: Bun.file(path.join(output, `${name}.stdout.log`)),
    }
  );
  const code = await child.exited;
  assert.equal(
    code,
    0,
    `${name} failed; inspect ${output}. Synthetic repositories are retained for diagnosis.`
  );
  console.log(`${name}: passed`);
}
assert.equal(
  digest(previous),
  predecessorDigest,
  "Predecessor changed during proof"
);
assert.equal(digest(target), targetDigest, "Target changed during proof");
const results = Object.fromEntries(
  cases.map((name) => {
    const filename = path.join(output, `${name}-results.json`);
    return [
      name,
      {
        digest: digest(filename),
        result: JSON.parse(readFileSync(filename, "utf-8")) as unknown,
      },
    ];
  })
);
writeFileSync(
  path.join(output, "certification.json"),
  `${JSON.stringify(
    {
      architecture: process.arch,
      bun: Bun.version,
      platform: process.platform,
      predecessor: { filename: previous, sha256: digest(previous) },
      target: { filename: target, sha256: digest(target) },
      ...(values.bootstrap !== undefined && values.bootstrap !== ""
        ? {
            bootstrap: {
              filename: realpathSync(values.bootstrap),
              sha256: digest(realpathSync(values.bootstrap)),
            },
          }
        : {}),
      ...(values.breaking !== undefined && values.breaking !== ""
        ? {
            breaking: {
              filename: environment.EFFECTORY_BREAKING_BINARY,
              sha256: digest(realpathSync(values.breaking)),
            },
          }
        : {}),
      results,
    },
    null,
    2
  )}\n`,
  { mode: 0o600 }
);
console.log(`Evidence: ${output}/certification.json`);

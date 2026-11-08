/**
 * Enforces Conventional Commits (https://www.conventionalcommits.org), which
 * release-please reads to pick the next version and write CHANGELOG.md.
 *
 *   bun scripts/commit-message.ts --file .git/COMMIT_EDITMSG   # commit-msg hook
 *   bun scripts/commit-message.ts --title "feat: add vaults"   # pull request title
 *   bun scripts/commit-message.ts --range origin/main..HEAD    # every new commit
 *
 * `feat` releases a minor version, `fix` and `perf` a patch, and `!` or a
 * `BREAKING CHANGE:` footer a breaking one. The other types never release.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export const commitTypes = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "docs",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
  "style",
] as const;

const maxHeaderLength = 100;
const header =
  /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9][a-z0-9._/-]*)\))?(?<breaking>!)?: (?<subject>\S.*)$/u;

/** Messages git writes itself; they never appear in the changelog. */
const generated = [/^Merge (?:branch|pull request|remote-tracking branch) /u];
const autosquash = /^(?:fixup|squash|amend)! /u;

export interface CommitOptions {
  /** Local commits may be autosquash fixups; shared history may not. */
  readonly allowAutosquash?: boolean;
}

/** Problems with a commit message or pull request title; empty when valid. */
export function commitMessageProblems(
  message: string,
  options: CommitOptions = {}
): readonly string[] {
  const lines = message
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim()
    .split("\n");
  const first = lines[0]?.trim() ?? "";
  if (first === "") {
    return ["The message is empty."];
  }
  if (generated.some((pattern) => pattern.test(first))) {
    return [];
  }
  if (options.allowAutosquash === true && autosquash.test(first)) {
    return [];
  }
  const problems: string[] = [];
  const match = header.exec(first);
  if (match?.groups === undefined) {
    problems.push(
      `"${first}" is not a conventional header: write "<type>(<optional scope>): <summary>", for example "fix(cli): report daemon start failures".`
    );
  } else if (
    !(commitTypes as readonly string[]).includes(match.groups.type ?? "")
  ) {
    problems.push(
      `"${match.groups.type}" is not a commit type; use one of ${commitTypes.join(", ")}.`
    );
  }
  if (first.length > maxHeaderLength) {
    problems.push(
      `The header is ${first.length} characters; keep it within ${maxHeaderLength}.`
    );
  }
  if (lines.length > 1 && lines[1]?.trim() !== "") {
    problems.push("Leave a blank line between the header and the body.");
  }
  return problems;
}

function commitsIn(range: string) {
  const result = Bun.spawnSync(
    ["git", "log", "--no-merges", "--format=%H%x00%B%x01", range],
    { stderr: "pipe", stdout: "pipe" }
  );
  if (result.exitCode !== 0) {
    throw new Error(`git log ${range}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout
    .toString()
    .split("\u0001")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [sha = "", body = ""] = entry.split("\u0000");
      return { body, sha };
    });
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      file: { type: "string" },
      range: { type: "string" },
      title: { type: "string" },
    },
  });
  const failures: string[] = [];
  if (values.file !== undefined) {
    const problems = commitMessageProblems(readFileSync(values.file, "utf-8"), {
      allowAutosquash: true,
    });
    failures.push(...problems);
  }
  if (values.title !== undefined) {
    failures.push(
      ...commitMessageProblems(values.title).map(
        (problem) => `Pull request title: ${problem}`
      )
    );
  }
  if (values.range !== undefined) {
    for (const commit of commitsIn(values.range)) {
      failures.push(
        ...commitMessageProblems(commit.body).map(
          (problem) => `${commit.sha.slice(0, 12)}: ${problem}`
        )
      );
    }
  }
  if (failures.length > 0) {
    process.stderr.write(
      `${failures.join("\n")}\n\nEffectory uses Conventional Commits; see AGENTS.md.\n`
    );
    process.exit(1);
  }
}

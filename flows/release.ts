/**
 * Release this repository: verify it with its own tools, read the commit with
 * git, ask a person to confirm, wait out a cooldown, then write release notes
 * and announce them. Nothing leaves the machine: notes and announcements are
 * files under `.effectory/releases`.
 */
import { Flow } from "@effectory/flow";
import { Data, Duration, Effect, FileSystem, Schema } from "effect";

import { Shell } from "./tools.ts";
import { CheckName, Verify } from "./verify.ts";

const releases = ".effectory/releases";

export class ReleaseBlocked extends Data.TaggedError("ReleaseBlocked")<{
  readonly message: string;
}> {}

export const HeadCommit = Flow.Task(
  "HeadCommit",
  {
    description: "Reads the commit being released with git.",
    input: Schema.Void,
    labels: ["tools"],
    output: Schema.Struct({ sha: Schema.String, subject: Schema.String }),
    timeout: "10 seconds",
  },
  () =>
    Effect.succeed({
      run: Effect.gen(function* headCommit() {
        const shell = yield* Shell;
        const { output } = yield* shell.run("git", [
          "log",
          "-1",
          "--pretty=%h%n%s",
        ]);
        const [sha = "", subject = ""] = output.trim().split("\n");
        return { sha, subject };
      }),
    })
);

export const ConfirmRelease = Flow.Input("ConfirmRelease", {
  description:
    'Confirm with {"_tag":"Ship","by":"<name>"} or stop it with {"_tag":"Stop","reason":"<why>"}.',
  input: Schema.Struct({
    checks: Schema.Array(Schema.String),
    sha: Schema.String,
    subject: Schema.String,
    version: Schema.String,
  }),
  labels: ["human"],
  output: Schema.Union([
    Schema.TaggedStruct("Ship", { by: Schema.String }),
    Schema.TaggedStruct("Stop", { reason: Schema.String }),
  ]),
});

export const Cooldown = Flow.Timer("Cooldown", {
  description: "Waits before publishing, in case someone shouts.",
  input: Schema.Finite,
  labels: ["timer"],
  wait: (seconds) => Duration.seconds(seconds),
});

export const Publish = Flow.Task(
  "Publish",
  {
    description: "Writes the release notes.",
    input: Schema.Struct({
      by: Schema.String,
      sha: Schema.String,
      subject: Schema.String,
      version: Schema.String,
    }),
    labels: ["tools"],
    output: Schema.String,
  },
  ({ by, sha, subject, version }) =>
    Effect.succeed({
      run: Effect.gen(function* publish() {
        const fs = yield* FileSystem.FileSystem;
        const file = `${releases}/${version}.md`;
        yield* fs.makeDirectory(releases, { recursive: true });
        yield* fs.writeFileString(
          file,
          `# ${version}\n\n${subject} (${sha})\n\nApproved by ${by}.\n`
        );
        return file;
      }),
    })
);

export const Announce = Flow.Task(
  "Announce",
  {
    description: "Announces a release on one channel.",
    input: Schema.Struct({ channel: Schema.String, version: Schema.String }),
    labels: ["tools"],
    output: Schema.String,
    retry: { times: 2 },
  },
  ({ channel, version }) =>
    Effect.succeed({
      run: Effect.gen(function* announce() {
        const fs = yield* FileSystem.FileSystem;
        const line = `[${channel}] Released ${version}\n`;
        yield* fs.makeDirectory(releases, { recursive: true });
        yield* fs.writeFileString(`${releases}/announcements.log`, line, {
          flag: "a",
        });
        return line.trim();
      }),
    })
);

export const Release = Flow.Task(
  "Release",
  {
    description:
      "Verifies, confirms with a person, waits out a cooldown, publishes and announces a release.",
    input: Schema.Struct({
      checks: Schema.Array(CheckName),
      cooldownSeconds: Schema.Finite,
      version: Schema.String,
    }),
    labels: ["entry", "human", "timer"],
    output: Schema.Struct({
      announced: Schema.Array(Schema.String),
      notes: Schema.String,
      version: Schema.String,
    }),
  },
  ({ checks, cooldownSeconds, version }) =>
    Effect.gen(function* release() {
      const verified = yield* Flow.After(Verify, checks);
      const head = yield* Flow.After(HeadCommit);
      const confirm = yield* Flow.Calls(ConfirmRelease);
      const cooldown = yield* Flow.Calls(Cooldown, { max: 1 });
      const publish = yield* Flow.Calls(Publish, { max: 1 });
      const announce = yield* Flow.Calls(Announce, { max: 2 });
      return {
        run: Effect.gen(function* releaseRun() {
          const report = yield* verified.output;
          if (!report.passed) {
            const failed = report.checks
              .filter((check) => !check.passed)
              .map((check) => check.name);
            return yield* new ReleaseBlocked({
              message: `Checks failed: ${failed.join(", ")}`,
            });
          }
          const { sha, subject } = yield* head.output;
          const decision = yield* confirm({
            checks: report.checks.map((check) => check.name),
            sha,
            subject,
            version,
          });
          if (decision._tag === "Stop") {
            return yield* new ReleaseBlocked({
              message: `Stopped: ${decision.reason}`,
            });
          }
          yield* cooldown(cooldownSeconds);
          const notes = yield* publish({
            by: decision.by,
            sha,
            subject,
            version,
          });
          const announced = yield* Effect.forEach(
            ["team", "changelog"],
            (channel) => announce({ channel, version })
          );
          return { announced, notes, version };
        }),
      };
    })
);

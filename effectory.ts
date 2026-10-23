/**
 * The Effectory collection: every workflow, Action, Resource type, Target,
 * and Trigger, and the Layers that provide what they need. The CLI loads this
 * file's default export.
 */
import { Collection, SecretStore, Target, Trigger } from "@effectory/core";
import {
  Agent,
  Claude,
  GitHub,
  Process,
  Service,
  ServiceProvider,
  Shell,
  Worktree,
  WorktreeProvider,
} from "@effectory/std";
import { Layer } from "effect";

import { implement } from "./workflows/implement.ts";
import {
  Review,
  ReleaseNote,
  reviewBranch,
} from "./workflows/review-branch.ts";
import { smoke } from "./workflows/smoke.ts";
import { verifyPr } from "./workflows/verify-pr.ts";

/** Verify a PR of this repository: `effectory run verify-pr --target effectory --input pr=12`. */
export const effectorySelf = Target.make(
  verifyPr,
  "effectory",
  {
    repo: {
      checks: [
        {
          args: ["install", "--frozen-lockfile"],
          command: "bun",
          name: "install",
        },
        { args: ["run", "typecheck"], command: "bun", name: "typecheck" },
        {
          args: ["run", "check"],
          command: "bun",
          name: "lint",
          severity: "medium",
        },
        { args: ["test"], command: "bun", name: "test" },
      ],
      clone: ".",
      name: "effectory",
      owner: "cypress-io",
    },
  },
  { description: "This repository's own checks", version: "1" }
);

interface PullRequestEvent {
  readonly action?: string;
  readonly number?: number;
}

/** `effectory serve`: verify this repository's PRs when they open or change. */
export const verifyOnPush = Trigger.webhook({
  map: (event) => {
    const { action, number } = event as PullRequestEvent;
    return (action === "opened" || action === "synchronize") &&
      number !== undefined
      ? { pr: number }
      : undefined;
  },
  name: "github-pull-request",
  route: "/github",
  target: effectorySelf,
  verify: Trigger.githubSignature("github-webhook-secret"),
});

export default Collection.make({
  actions: [Shell, Agent.Prompt, Review, ReleaseNote],
  description:
    "Typed automations for verifying, reviewing, and implementing changes in other repositories.",
  name: "effectory",
  providers: Layer.mergeAll(
    WorktreeProvider,
    ServiceProvider,
    GitHub.PullRequestCommentProvider
  ),
  resources: [Worktree, Service, GitHub.PullRequestComment],
  services: Layer.mergeAll(
    Process.layer,
    Agent.make(Claude.make()),
    GitHub.live,
    SecretStore.env
  ),
  targets: [effectorySelf],
  triggers: [verifyOnPush],
  workflows: [verifyPr, reviewBranch, implement, smoke],
});

import { Assert, Lifetime, Output, Report, Workflow } from "@effectory/core";
import { Http, Service, Shell, Worktree } from "@effectory/std";
import { Effect, Schema } from "effect";

const server = (port: number) =>
  `Bun.serve({ port: ${port}, fetch: () => new Response("ok from " + process.cwd()) })`;

/**
 * Exercise the local standard library for real: check out a ref of a local
 * repository into a temporary worktree, start a background HTTP service in
 * it, query the service, and assert on the response. Everything is
 * run-lifetime, so nothing is left behind.
 */
export const smoke = Workflow.make(
  "smoke",
  {
    description:
      "Check out a local repo into a temporary worktree, run a background HTTP service there, query it, and assert.",
    input: Schema.Struct({
      port: Schema.optionalKey(Schema.Int),
      ref: Schema.optionalKey(Schema.String),
      repo: Schema.String,
    }),
    reports: [Report.summary],
    scope: ({ ref, repo }) => `${repo}@${ref ?? "HEAD"}`,
  },
  Effect.fn(function* smokeTest({ port, ref, repo }) {
    const listen = port ?? 48_731;
    const url = `http://127.0.0.1:${listen}/`;
    const checkout = yield* Worktree("checkout", {
      ref: ref ?? "HEAD",
      repo,
    }).pipe(Lifetime.run);
    const files = yield* Shell("files", {
      args: ["ls-files"],
      command: "git",
      cwd: checkout.path,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    const service = yield* Service("server", {
      args: ["-e", server(listen)],
      command: "bun",
      cwd: checkout.path,
      ready: Http.ok(url, { timeoutMs: 10_000 }),
    }).pipe(Lifetime.run);
    const response = yield* Shell(
      "query",
      { args: ["-s", url], command: "curl" },
      { dependsOn: [service] }
    );
    yield* Assert("tracked-files", {
      message: Output.map(
        files,
        (result) =>
          `${result.stdout.split("\n").filter(Boolean).length} tracked files`
      ),
      that: Output.map(files, (result) =>
        result.stdout.includes("effectory.ts")
      ),
    });
    yield* Assert("served-from-worktree", {
      message: Output.map(response, (result) => `response: ${result.stdout}`),
      that: Output.map(
        Output.all({ checkout, response }),
        ({ checkout: tree, response: result }) =>
          result.stdout.includes(tree.path)
      ),
    });
    return { head: checkout.head, pid: service.pid };
  })
);

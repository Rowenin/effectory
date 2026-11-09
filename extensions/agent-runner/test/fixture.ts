// Executed in a disposable subprocess by runner.test.ts.
import { appendFileSync, writeFileSync } from "node:fs";

const mode = process.env.FIXTURE_MODE ?? "success";
const kind = process.env.FIXTURE_KIND ?? "claude";
const record = process.env.FIXTURE_RECORD;
const payload: unknown =
  process.env.FIXTURE_PAYLOAD === undefined
    ? { count: 2, ok: true }
    : JSON.parse(process.env.FIXTURE_PAYLOAD);
const wire = {
  output: mode === "wrong-structured" ? { count: "wrong" } : payload,
};
function log(value: unknown) {
  if (record !== undefined) {
    appendFileSync(record, `${JSON.stringify(value)}\n`);
  }
}
if (process.argv.includes("--version")) {
  process.stdout.write(mode === "version-mismatch" ? "2.0.0\n" : "1.0.0\n");
} else if (process.argv.includes("serve")) {
  const session = {
    directory: process.cwd(),
    id: "ses_fixture",
    projectID: "project",
    slug: "fixture",
    time: { created: 1, updated: 1 },
    title: "fixture",
    version: "1.0.0",
  };
  const server = Bun.serve({
    fetch: async (request) => {
      const url = new URL(request.url);
      const raw = await request.text();
      const body: unknown = raw.length === 0 ? null : JSON.parse(raw);
      log({
        auth: request.headers.get("authorization") !== null,
        body,
        path: url.pathname,
      });
      if (url.pathname === "/global/health") {
        return Response.json({ healthy: true, version: "1.0.0" });
      }
      if (url.pathname.endsWith("/abort")) {
        return Response.json(true);
      }
      if (url.pathname.endsWith("/message")) {
        const structured =
          typeof body === "object" && body !== null && "format" in body;

        if (mode === "capacity") {
          return Response.json({ message: "capacity" }, { status: 429 });
        }
        if (mode === "hang") {
          await Bun.sleep(60_000);
        }
        return Response.json({
          info: {
            ...(structured && mode !== "missing-structured"
              ? { structured: wire }
              : {}),
            ...(mode === "structured-failure"
              ? {
                  error: {
                    data: { message: "CANARY-invalid-output", retries: 0 },
                    name: "StructuredOutputError",
                  },
                }
              : {}),
            agent: "build",
            cost: 0.01,
            finish: "stop",
            id: "msg_fixture",
            mode: "build",
            modelID: "model",
            parentID: "msg_parent",
            path: { cwd: process.cwd(), root: process.cwd() },
            providerID: "provider",
            role: "assistant",
            sessionID: session.id,
            time: { completed: 2, created: 1 },
            tokens: {
              cache: { read: 0, write: 0 },
              input: 3,
              output: 2,
              reasoning: 0,
            },
          },
          parts: [
            {
              id: "part_fixture",
              messageID: "msg_fixture",
              sessionID: session.id,
              text: "done",
              type: "text",
            },
          ],
        });
      }
      return Response.json(session);
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  process.stdout.write(
    `opencode server listening on http://127.0.0.1:${server.port}\n`
  );
} else {
  const schemaIndex = process.argv.indexOf("--output-schema");
  const claudeIndex = process.argv.indexOf("--json-schema");
  const schemaPath = process.argv[schemaIndex + 1];
  let schema: unknown;
  if (schemaIndex !== -1 && schemaPath !== undefined) {
    schema = JSON.parse(await Bun.file(schemaPath).text());
  } else if (claudeIndex !== -1) {
    schema = JSON.parse(process.argv[claudeIndex + 1] ?? "null");
  }
  const structured = schema !== undefined;
  log({
    ...(structured
      ? { schema, ...(schemaIndex === -1 ? {} : { schemaPath }) }
      : {}),
    args: process.argv.slice(2),
    inheritedHome: process.env.HOME !== undefined,
    pid: process.pid,
    prompt: await Bun.stdin.text(),
  });
  if (mode === "auth") {
    process.stderr.write("401 missing authentication CANARY-secret");
    process.exit(1);
  } else if (mode === "hang") {
    const descendant = Bun.spawn(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      { stderr: "ignore", stdout: "ignore" }
    );
    if (record !== undefined) {
      writeFileSync(`${record}.pid`, String(descendant.pid));
    }
    setInterval(() => {
      /* Keep the fixture process alive for cancellation. */
    }, 1000);
  } else if (mode === "large") {
    process.stdout.write("x".repeat(600_000));
  } else if (mode === "malformed") {
    process.stdout.write("not json\n");
  } else if (kind === "claude") {
    let subtype = "success";
    if (mode === "structured-failure") {
      subtype = "error_max_structured_output_retries";
    } else if (mode === "fail") {
      subtype = "error_during_execution";
    }
    const result = {
      ...(structured && mode !== "missing-structured"
        ? { structured_output: wire }
        : {}),
      is_error: mode === "fail" || mode === "structured-failure",
      result: "done",
      session_id: "session_fixture",
      subtype,
      type: "result",
      usage: { input_tokens: 3, output_tokens: 2 },
    };
    process.stdout.write(
      `${JSON.stringify(mode === "verbose-json" ? [{ type: "system" }, result] : result)}\n`
    );
  } else {
    const events = [
      { thread_id: "thread_fixture", type: "thread.started" },
      {
        item: {
          text:
            structured && mode !== "missing-structured"
              ? JSON.stringify(wire)
              : "done",
          type: "agent_message",
        },
        type: "item.completed",
      },
      mode === "fail"
        ? { error: { message: "rate_limit" }, type: "turn.failed" }
        : {
            type: "turn.completed",
            usage: { input_tokens: 3, output_tokens: 2 },
          },
    ];
    process.stdout.write(
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
    );
  }
}

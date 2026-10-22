import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { chmod, realpath, unlink } from "node:fs/promises";
import { userInfo } from "node:os";

import { Schema } from "effect";

import { prepareDatabase } from "./database.ts";
import { openEngine } from "./engine.ts";
import type { LocalEngine } from "./engine.ts";
import { workspaceEntrypoint } from "./entrypoint.ts";
import { fingerprintTask } from "./fingerprint.ts";
import { workspacePaths } from "./paths.ts";
import { ControlRequest } from "./protocol.ts";
import type { ControlMessage } from "./protocol.ts";
import type { RegisteredTask } from "./task.ts";
import {
  listTaskDirectories,
  loadTaskCatalog,
  loadWorkspaceConfig,
} from "./tasks.ts";

export const controlSocket = (workspace: string) =>
  workspacePaths(workspace).socket;

const RevisionRecord = Schema.Struct({
  id: Schema.String,
  revision: Schema.String,
  status: Schema.String,
  task: Schema.String,
});

/** Refuse changed executable code before importing task modules or activating the engine. */
const checkRevisions = (workspace: string) => {
  const filename = prepareDatabase(workspace);
  if (!existsSync(filename)) {
    return;
  }
  const db = new Database(filename, { readonly: true });
  try {
    const table = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='effectory_runs'"
      )
      .get();
    if (!table) {
      return;
    }
    const entrypoint = workspaceEntrypoint(workspace);
    const entryRevision = entrypoint?.endsWith("/effectory.run.ts")
      ? fingerprintTask(workspace, entrypoint).digest
      : undefined;
    const revisions = new Map(
      (entryRevision ? [] : listTaskDirectories(workspace)).map((task) => [
        task.name,
        fingerprintTask(workspace, task.entrypoint).digest,
      ])
    );
    for (const row of db
      .query<{ data: string }, []>("SELECT data FROM effectory_runs")
      .all()) {
      const run = Schema.decodeUnknownSync(RevisionRecord)(
        JSON.parse(row.data)
      );
      if (
        !["succeeded", "failed", "cancelled"].includes(run.status) &&
        (entryRevision ?? revisions.get(run.task)) !== run.revision
      ) {
        throw new Error(
          `Unfinished run ${run.id} requires task ${run.task} revision ${run.revision}. Restore its source and lockfile before restarting.`
        );
      }
    }
  } finally {
    db.close();
  }
};

const description = (task: RegisteredTask) => ({
  description: task.description,
  inputSchema: task.inputSchema,
  name: task.name,
  revision: task.fingerprint.digest,
  workflow: task.workflow._tag,
});

const execute = (
  engine: LocalEngine,
  tasks: readonly RegisteredTask[],
  request: ControlMessage
): unknown => {
  switch (request.method) {
    case "task.list": {
      return tasks.map(description);
    }
    case "task.describe": {
      const task = tasks.find((candidate) => candidate.name === request.name);
      if (!task) {
        throw new Error(`Unknown workflow: ${request.name}`);
      }
      return description(task);
    }
    case "task.run": {
      return engine.submit(request);
    }
    case "run.list": {
      return engine.listRuns();
    }
    case "run.inspect": {
      return engine.inspectRun(request.id);
    }
    case "run.cancel": {
      return engine.cancelRun(request.id);
    }
    case "run.resume": {
      return engine.resumeRun(request.id);
    }
    case "artifact.list": {
      return engine.listArtifacts(request.runId);
    }
    case "artifact.get": {
      return engine.getArtifact(request.id);
    }
    case "approval.list": {
      return engine.listApprovals();
    }
    case "approval.inspect": {
      return engine.inspectApproval(request.id);
    }
    case "approval.decide": {
      return engine.decideApproval({
        ...request,
        operator: userInfo().username,
      });
    }
    default: {
      throw new Error("Unsupported local control method");
    }
  }
};

export interface RuntimeOptions {
  execute?: boolean;
  loadTasks?: boolean;
  loadConfig?: boolean;
}

export const startControlServer = async (
  inputWorkspace: string,
  options: RuntimeOptions = {}
) => {
  const workspace = await realpath(inputWorkspace);
  if (options.execute !== false) {
    checkRevisions(workspace);
  }
  const tasks =
    options.loadTasks === false && options.execute === false
      ? []
      : await loadTaskCatalog(workspace);
  const config =
    options.execute !== false ||
    options.loadTasks !== false ||
    options.loadConfig
      ? await loadWorkspaceConfig(workspace)
      : undefined;
  const engine = await openEngine({
    ...options,
    tasks,
    workspace,
    ...(config ? { config } : {}),
  });
  const socket = controlSocket(workspace);
  let stopServer: (() => Promise<void>) | undefined;
  try {
    // Only the owner may remove a socket left by its dead predecessor.
    await unlink(socket).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    const server = Bun.serve({
      async fetch(request) {
        if (
          request.method !== "POST" ||
          new URL(request.url).pathname !== "/control" ||
          request.headers.has("origin")
        ) {
          return Response.json(
            { error: "Unsupported local request", ok: false },
            { status: 400 }
          );
        }
        try {
          const message = Schema.decodeUnknownSync(ControlRequest)(
            await request.json()
          );
          const value = await execute(engine, tasks, message);
          return Response.json({ ok: true, value });
        } catch (error) {
          return Response.json(
            {
              error: error instanceof Error ? error.message : String(error),
              ok: false,
            },
            { status: 400 }
          );
        }
      },
      maxRequestBodySize: 512 * 1024,
      unix: socket,
    });
    const stop = async () => {
      try {
        await server.stop(true);
      } finally {
        await unlink(socket).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
        });
      }
    };
    stopServer = stop;
    await chmod(socket, 0o600);
    let closing: Promise<void> | undefined;
    return {
      close: () => {
        closing ??= (async () => {
          try {
            await stop();
          } finally {
            await engine.close();
          }
        })();
        return closing;
      },
      engine,
      request: async (message: ControlMessage) =>
        await execute(engine, tasks, message),
      socket,
      workspace,
    };
  } catch (error) {
    try {
      await stopServer?.();
    } finally {
      await engine.close();
    }
    throw error;
  }
};

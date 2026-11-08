import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import { Schema } from "effect";

// Routing metadata only. Presence always refuses normal writers, including an
// unknown future phase or damaged record. Only upgrade apply may resume an
// accepted transition; no startup or maintenance path may acknowledge it.
const Routing = Schema.Struct({
  format: Schema.Literal(1),
  planId: Schema.String.check(
    Schema.isPattern(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u)
  ),
  targetBuild: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
// Sharing the existing maintenance gate makes predecessor hosts refuse too:
// their format-1 decoder rejects this new routing record before any write.
const ReclaimRouting = Schema.Struct({
  format: Schema.Literal(2),
  kind: Schema.Literal("RevisionReclaim"),
  planId: Routing.fields.planId,
  targetBuild: Routing.fields.targetBuild,
});
const missing = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  Reflect.get(cause, "code") === "ENOENT";
const refused = (message: string) =>
  new OperationError({ code: "RevisionUnavailable", message });

/** File-only, non-mutating check, called while repository ownership is held. */
export function assertUpgradeIdle(repository: string) {
  const directory = path.join(repository, ".effectory", "upgrades");
  const filename = path.join(directory, "active.json");
  let routing: typeof Routing.Type | typeof ReclaimRouting.Type | undefined;
  try {
    let directoryStat;
    try {
      directoryStat = lstatSync(directory);
    } catch (error) {
      if (missing(error)) {
        return;
      }
      throw error;
    }
    if (!directoryStat.isDirectory()) {
      throw new Error("Invalid transition directory");
    }
    let stat;
    try {
      stat = lstatSync(filename);
    } catch (error) {
      if (missing(error)) {
        return;
      }
      throw error;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65_536) {
      throw new Error("Invalid transition intent");
    }
    routing = Schema.decodeUnknownSync(Schema.Union([Routing, ReclaimRouting]))(
      JSON.parse(readFileSync(filename, "utf-8"))
    );
  } catch {
    throw refused(
      "Runtime upgrade state is unsupported or damaged; preserve the repository and inspect it with the host that accepted the transition before running any writer"
    );
  }
  if (routing.format === 2) {
    throw refused(
      `Revision reclamation ${routing.planId} is unfinished. Use host build ${routing.targetBuild} and run effectory revision reclaim apply ${routing.planId}; normal startup and offline maintenance cannot resume it.`
    );
  }
  throw refused(
    `Runtime upgrade ${routing.planId} is unfinished. Use host build ${routing.targetBuild} and run effectory upgrade apply ${routing.planId}; normal startup and offline maintenance cannot resume it.`
  );
}

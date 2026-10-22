import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { RuntimeStore } from "./store.ts";

// PID plus OS start time distinguishes a reused PID from the original owner.
// Failure to inspect a live process is conservative: ownership stays with it.
const processIdentity = (pid: number): string | undefined => {
  try {
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf-8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
};

/** Claim under a SQLite write transaction; nonce cleanup cannot release a replacement owner. */
export const claimWorkspace = (
  store: Pick<RuntimeStore, "db" | "transaction">
): (() => void) => {
  const nonce = randomUUID();
  const identity = processIdentity(process.pid);
  store.transaction(() => {
    const owner = store.db
      .query<{ pid: number; identity: string | null }, []>(
        "SELECT pid,identity FROM effectory_owner WHERE id=1"
      )
      .get();
    if (owner) {
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          alive = false;
        }
      }
      const actualIdentity = alive ? processIdentity(owner.pid) : undefined;
      if (
        alive &&
        !(owner.identity && actualIdentity && owner.identity !== actualIdentity)
      ) {
        throw new Error(`Workspace already owned by runner PID ${owner.pid}`);
      }
    }
    store.db
      .query(
        "INSERT INTO effectory_owner(id,pid,nonce,identity) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,nonce=excluded.nonce,identity=excluded.identity"
      )
      .run(process.pid, nonce, identity ?? null);
  });
  return () => {
    store.db
      .query("DELETE FROM effectory_owner WHERE id=1 AND nonce=?")
      .run(nonce);
  };
};

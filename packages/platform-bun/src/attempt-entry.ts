import type { Identity } from "@offtree/effectory-sdk/Task";

// Private entry fencing travels with the exact identity object, never over an API.
const entries = new WeakMap<Identity, number>();
export function bindAttemptEntry(identity: Identity, entry: number) {
  entries.set(identity, entry);
}
export function attemptEntry(identity: Identity) {
  return entries.get(identity);
}

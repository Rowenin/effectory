import { Schema } from "effect";

import type { RevisionProtection } from "./revision-reclaim-record.ts";
import type { upgradeScanner } from "./upgrade-scan.ts";

export const reclaimDecode = <
  S extends Schema.Codec<unknown, unknown, never, never>,
>(
  schema: S,
  row: unknown
) => Schema.decodeUnknownSync(schema)(row, { onExcessProperty: "error" });

export type ReclaimScanner = ReturnType<typeof upgradeScanner>;
export type ProtectRevision = (
  revision: string,
  kind: (typeof RevisionProtection.Type)["reasons"][number]["kind"],
  id: string
) => void;

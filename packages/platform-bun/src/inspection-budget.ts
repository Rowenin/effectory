import { createHash } from "node:crypto";

import { OperationError } from "@effectory/runtime/protocol";

/** Shared by every scan in one offline inspection, including repeated visits. */
export function inspectionBudget(purpose: string) {
  let rows = 0;
  let bytes = 0;
  const hash = createHash("sha256");
  return {
    get snapshot() {
      return { bytes, digest: hash.copy().digest("hex"), rows };
    },
    visit(category: string, row: unknown, fingerprint = true) {
      const encoded = JSON.stringify(row);
      rows += 1;
      bytes += Buffer.byteLength(encoded);
      if (rows > 1_000_000 || bytes > 268_435_456) {
        throw new OperationError({
          code: "LimitExceeded",
          message: `${purpose} exceeds one million headers or 256 MiB; no applicable preview was produced`,
        });
      }
      // Length-delimited tuples prevent category/row boundary ambiguity.
      if (fingerprint) {
        hash.update(JSON.stringify([category, encoded]));
      }
    },
  };
}

export type InspectionBudget = ReturnType<typeof inspectionBudget>;

import { statSync, statfsSync } from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";
import type { DiagnosticFinding } from "@effectory/runtime/system-protocol";
import { Effect } from "effect";

import { HostStore } from "./host-store.ts";

/** A bounded read-only health report, not an exhaustive content-integrity audit. */
export const doctor = (directory: string) =>
  Effect.gen(function* () {
    const store = yield* HostStore;
    const health = yield* store.health();
    const disk = yield* Effect.try({
      catch: () =>
        new OperationError({
          code: "Unavailable",
          message: "Cannot inspect repository storage metadata",
        }),
      try: () => ({
        credentials: statSync(path.join(directory, "credentials.json")),
        space: statfsSync(directory),
      }),
    });
    const findings: (typeof DiagnosticFinding.Type)[] = [];
    const availableBytes = disk.space.bavail * disk.space.bsize;
    if (availableBytes < 67_108_864) {
      findings.push({
        code: "LowStorage",
        message: "Less than 64 MiB of storage is available",
        severity: "Warning",
      });
    }
    // oxlint-disable-next-line no-bitwise -- Inspect POSIX group/other permission bits.
    if ((disk.credentials.mode & 0o077) !== 0) {
      findings.push({
        code: "CredentialPermissions",
        message: "Repository credentials are accessible beyond their owner",
        severity: "Error",
      });
    }
    if (store.telemetryWriteFailures > 0) {
      findings.push({
        code: "TelemetryWriteFailure",
        message:
          "Some best-effort logs or progress could not be persisted during this daemon instance",
        severity: "Warning",
      });
    }
    if (store.storageFailures > 0) {
      findings.push({
        code: "StorageFull",
        message:
          "Persistence encountered storage exhaustion during this instance; accepted records remain retained",
        severity: "Error",
      });
    }
    findings.push({
      code: "RepositoryOwner",
      message: "This daemon holds exclusive repository ownership",
      severity: "Info",
    });
    return {
      checkedAt: new Date().toISOString(),
      counts: {
        ...health.counts,
        storageFailures: store.storageFailures,
        telemetryWriteFailures: store.telemetryWriteFailures,
      },
      findings,
      healthy: !findings.some((finding) => finding.severity === "Error"),
      storage: { ...health.storage, availableBytes },
    };
  });

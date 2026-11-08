import { ReclamationRequest } from "@effectory/runtime/lake-protocol";
import { OperationError } from "@effectory/runtime/protocol";
import { Duration, Effect, Option, Schema } from "effect";

interface Flags {
  readonly policy: boolean;
  readonly schema?: string;
  readonly schemaVersion?: number;
  readonly artifact?: string;
  readonly version?: number;
  readonly olderThan?: string;
  readonly keepLatest?: number;
}
const invalid = (message: string) =>
  new OperationError({ code: "InvalidInput", message });

function selectionInput(flags: Flags) {
  let millis: number | undefined;
  if (flags.olderThan !== undefined) {
    const parsed = Duration.fromInput(flags.olderThan as Duration.Input);
    millis = Option.isSome(parsed)
      ? Math.floor(Duration.toMillis(parsed.value))
      : Number.NaN;
    if (!Number.isSafeInteger(millis) || millis < 1) {
      throw invalid(
        "--older-than requires a finite duration of at least 1 millisecond, such as '30 days'"
      );
    }
  }
  return {
    _tag: "Selection",
    schemaId: flags.schema,
    ...(flags.schemaVersion === undefined
      ? {}
      : { schemaVersion: flags.schemaVersion }),
    ...(flags.artifact === undefined ? {} : { artifactId: flags.artifact }),
    ...(millis === undefined ? {} : { olderThanMillis: millis }),
    ...(flags.keepLatest === undefined ? {} : { keepLatest: flags.keepLatest }),
  };
}

export function parseReclamation(flags: Flags): ReclamationRequest {
  const selecting =
    flags.olderThan !== undefined || flags.keepLatest !== undefined;
  if (
    flags.policy &&
    (selecting || flags.artifact !== undefined || flags.version !== undefined)
  ) {
    throw invalid(
      "--policy cannot be combined with operator selection or explicit version deletion"
    );
  }
  let input: unknown;
  if (flags.version !== undefined) {
    if (
      flags.artifact === undefined ||
      selecting ||
      flags.schema !== undefined ||
      flags.schemaVersion !== undefined
    ) {
      throw invalid(
        "Explicit version removal requires only --artifact ID --version N"
      );
    }
    input = {
      _tag: "Version",
      artifactId: flags.artifact,
      version: flags.version,
    };
  } else if (selecting) {
    input = selectionInput(flags);
  } else {
    if (flags.artifact !== undefined) {
      throw invalid(
        "--artifact requires --version, or a --schema selection with --older-than/--keep-latest"
      );
    }
    input = {
      _tag: "Policy",
      ...(flags.schema === undefined ? {} : { schemaId: flags.schema }),
      ...(flags.schemaVersion === undefined
        ? {}
        : { schemaVersion: flags.schemaVersion }),
    };
  }
  try {
    return Schema.decodeUnknownSync(ReclamationRequest)(input, {
      onExcessProperty: "error",
    });
  } catch {
    throw invalid(
      "Invalid reclamation flags: bulk selections require --schema and positive integer version/count values"
    );
  }
}

export function retentionFor<E, R>(client: {
  readonly SystemStatus: (
    request: Record<never, never>
  ) => Effect.Effect<{ readonly capabilities: readonly string[] }, E, R>;
}) {
  return Effect.gen(function* () {
    const status = yield* client.SystemStatus({});
    if (!status.capabilities.includes("lake.retention.v1")) {
      return yield* new OperationError({
        code: "Unavailable",
        message:
          "This daemon does not support lake reclamation; upgrade and restart it first",
      });
    }
  });
}

export function automaticRetentionFor<E, R>(client: {
  readonly SystemStatus: (
    request: Record<never, never>
  ) => Effect.Effect<{ readonly capabilities: readonly string[] }, E, R>;
}) {
  return Effect.gen(function* () {
    if (
      !(yield* client.SystemStatus({})).capabilities.includes(
        "lake.retention.automatic.v1"
      )
    ) {
      return yield* new OperationError({
        code: "Unavailable",
        message:
          "This daemon does not support automatic retention; run effectory daemon stop and effectory daemon start with the new CLI",
      });
    }
  });
}

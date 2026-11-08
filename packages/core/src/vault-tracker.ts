import { Cause, Context, Effect, Exit, Function } from "effect";

import { TaskRuntimeError } from "./errors.ts";
import { VaultFailure } from "./vault-errors.ts";

interface Needle {
  readonly text: string;
  readonly vault: string;
  readonly key: string;
}
export interface Tracker {
  open: boolean;
  cleared: boolean;
  bytes: number;
  readonly needles: Map<string, Needle>;
}
export const RevisionBuild = Context.Reference<boolean>(
  "@offtree/effectory-sdk/internal/VaultRevisionBuild",
  { defaultValue: () => false }
);
export const Invocation = Context.Reference<Tracker | undefined>(
  "@offtree/effectory-sdk/internal/VaultInvocation",
  { defaultValue: Function.constUndefined }
);
export const make = (): Tracker => ({
  bytes: 0,
  cleared: false,
  needles: new Map(),
  open: true,
});
export const close = (tracker: Tracker) => {
  tracker.open = false;
};
export const clear = (tracker: Tracker) => {
  close(tracker);
  tracker.cleared = true;
  tracker.bytes = 0;
  tracker.needles.clear();
};
const byteLength = (value: string) =>
  new TextEncoder().encode(value).byteLength;

export function register(
  tracker: Tracker,
  vault: string,
  key: string,
  raw: string,
  structured: boolean
) {
  if (!tracker.open) {
    throw new VaultFailure({ key, reason: "Closed", vault });
  }
  const limit = () => new VaultFailure({ key, reason: "LimitExceeded", vault });
  if (byteLength(raw) > 65_536) {
    throw limit();
  }
  const values = new Set([raw]);
  if (structured) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed !== null && typeof parsed === "object") {
      let leaves = 0;
      const walk = (value: unknown, depth: number) => {
        if (depth > 16) {
          throw limit();
        }
        if (typeof value === "string") {
          leaves += 1;
          if (leaves > 256) {
            throw limit();
          }
          values.add(value);
        } else if (value !== null && typeof value === "object") {
          for (const child of Object.values(value)) {
            walk(child, depth + 1);
          }
        }
      };
      walk(parsed, 0);
    }
  }
  const additions = new Map<string, Needle>();
  let bytes = 0;
  for (const value of values) {
    if (byteLength(value) < 8) {
      continue;
    }
    for (const text of new Set([value, JSON.stringify(value).slice(1, -1)])) {
      if (tracker.needles.has(text) || additions.has(text)) {
        continue;
      }
      bytes += byteLength(text);
      additions.set(text, { key, text, vault });
    }
  }
  if (
    tracker.bytes + bytes > 1_048_576 ||
    tracker.needles.size + additions.size > 256
  ) {
    throw limit();
  }
  for (const [text, needle] of additions) {
    tracker.needles.set(text, needle);
  }
  tracker.bytes += bytes;
}

export function scrub(tracker: Tracker | undefined, text: string): string {
  if (!tracker) {
    return text;
  }
  if (tracker.cleared) {
    return "[late output omitted]";
  }
  if (tracker.needles.size && text.length > 65_536) {
    return "[oversized output omitted]";
  }
  for (const needle of tracker.needles.values()) {
    if (text.includes(needle.text)) {
      return "[vault secret omitted]";
    }
  }
  return text;
}

/** Checks an owned serialization; callers must persist this representation. */
export function checkSerialized(text: string, tracker?: Tracker) {
  return Effect.gen(function* () {
    const current = tracker ?? (yield* Invocation);
    if (!current) {
      return;
    }
    if (current.cleared) {
      return yield* new TaskRuntimeError({
        code: "SecretInOutput",
        message: "Invocation protection is closed",
      });
    }
    let count = 0;
    for (const needle of current.needles.values()) {
      if (text.includes(needle.text)) {
        return yield* new TaskRuntimeError({
          code: "SecretInOutput",
          message: `Output contains vault secret ${needle.vault}/${needle.key}`,
        });
      }
      count += 1;
      if (count % 8 === 0) {
        yield* Effect.yieldNow;
      }
    }
  });
}

export function sanitizeCause<E>(
  tracker: Tracker,
  cause: Cause.Cause<E>
): Cause.Cause<E> {
  return Cause.fromReasons(
    cause.reasons.map((reason) => {
      if (!Cause.isDieReason(reason)) {
        return reason;
      }
      // Do not invoke arbitrary defect getters or toString implementations.
      let text = "";
      try {
        text =
          typeof reason.defect === "string"
            ? reason.defect
            : Cause.pretty(Cause.fromReasons([reason]));
      } catch {
        text = "[unreadable defect]";
      }
      const safe = scrub(tracker, text);
      return safe === text ? reason : Cause.makeDieReason(new Error(safe));
    })
  );
}

/** Owned by Activity/Task.test, outside task-local Layers and final encoding. */
export function protect<A, E, R>(
  body: (tracker: Tracker) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(make),
    (tracker) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.exit(
          restore(
            body(tracker).pipe(Effect.provideService(Invocation, tracker))
          )
        ).pipe(
          Effect.flatMap((exit) =>
            Exit.isFailure(exit)
              ? Effect.failCause(sanitizeCause(tracker, exit.cause))
              : Effect.succeed(exit.value)
          )
        )
      ),
    (tracker) => Effect.sync(() => clear(tracker))
  );
}

export const building = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.updateContext((context: Context.Context<R>) =>
      Context.add(Context.omit(Invocation)(context), RevisionBuild, true)
    )
  );

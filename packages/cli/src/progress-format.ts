import type { RunWatchFrame } from "@effectory/runtime/history-protocol";
import { Option, Schema } from "effect";

const unsafe = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const escaped = /^\\(?:u\{[\da-f]+\}|u[\da-f]{4}|["\\/bfnrt])/iu;
const limit = 2048;
const suffix = "… [truncated]";

/** Counts Unicode code points, matching string iteration. */
export const codePointLength = (text: string) =>
  text.match(/./gsu)?.length ?? 0;

/** Escape before limiting, retaining whole code points and whole escape tokens. */
function bounded(text: string) {
  const tokens: string[] = [];
  let length = 0;
  for (let index = 0; index < text.length;) {
    const point = text.codePointAt(index);
    if (point === undefined) {
      break;
    }
    const character = String.fromCodePoint(point);
    let token = character;
    let consumed = character.length;
    if (unsafe.test(character)) {
      token =
        point <= 0xff_ff
          ? `\\u${point.toString(16).padStart(4, "0")}`
          : `\\u{${point.toString(16)}}`;
    } else if (character === "\\") {
      const match = escaped.exec(text.slice(index, index + 12));
      if (match) {
        [token] = match;
        consumed = token.length;
      }
    }
    const size = codePointLength(token);
    if (length + size > limit) {
      while (length + suffix.length > limit) {
        const removed = tokens.pop();
        if (removed === undefined) {
          break;
        }
        length -= codePointLength(removed);
      }
      return tokens.join("") + suffix;
    }
    tokens.push(token);
    length += size;
    index += consumed;
  }
  return tokens.join("");
}

const string = Schema.decodeUnknownOption(Schema.String);
const number = Schema.decodeUnknownOption(Schema.Finite);
const json = Schema.decodeUnknownOption(Schema.Json);
const showError = (level: unknown, error: unknown) =>
  (level === "Error" || level === "Fatal") && error !== null;
function deadlineLabel(value: unknown) {
  const deadline = number(value);
  return Option.isSome(deadline) &&
    Math.abs(deadline.value) <= 8_640_000_000_000_000
    ? `deadline=${new Date(deadline.value).toISOString()}`
    : undefined;
}

/** A malformed optional field must not hide independent valid display fields. */
function details(tag: string, payload: Schema.Json) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return "";
  }
  const field = (name: string): unknown =>
    Object.hasOwn(payload, name) ? Reflect.get(payload, name) : undefined;
  const parts: string[] = [];
  const text = (name: string, label = "") => {
    const value = string(field(name));
    if (Option.isSome(value)) {
      parts.push(`${label}${value.value}`);
    }
  };
  const count = (name: string, label = `${name}=`) => {
    const value = number(field(name));
    if (Option.isSome(value)) {
      parts.push(`${label}${value.value}`);
    }
  };
  const encoded = (name: string, label = "") => {
    const value = json(field(name));
    if (Option.isSome(value)) {
      parts.push(`${label}${JSON.stringify(value.value)}`);
    }
  };
  const node = () => text("nodeId", "node=");
  switch (tag) {
    case "RunStatus": {
      text("status");
      break;
    }
    case "AttemptStarted": {
      node();
      count("attempt");
      break;
    }
    case "Log": {
      text("level");
      node();
      encoded("message");
      if (showError(field("level"), field("error"))) {
        encoded("error", "error=");
      }
      break;
    }
    case "Progress": {
      node();
      text("message");
      count("completed");
      count("total");
      break;
    }
    case "WaitOpened": {
      text("waitId", "wait=");
      node();
      break;
    }
    case "WaitSettled": {
      text("waitId", "wait=");
      text("status");
      break;
    }
    case "ArtifactPublished": {
      text("artifactId", "artifact=");
      count("version");
      break;
    }
    case "RetryScheduled": {
      node();
      count("attempt", "nextAttempt=");
      const deadline = deadlineLabel(field("deadline"));
      if (deadline !== undefined) {
        parts.push(deadline);
      }
      break;
    }
    case "NeedsAttention": {
      node();
      count("attempt");
      count("entry");
      break;
    }
    case "CancellationRequested": {
      text("actor", "actor=");
      text("reason", "reason=");
      break;
    }
    case "FinalizationStalled": {
      text("message");
      break;
    }
    case "DeadlineStarted": {
      text("name");
      break;
    }
    case "TelemetryTruncated": {
      parts.push("stored telemetry was truncated");
      break;
    }
    default: {
      break;
    }
  }
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

/** Private presentation formatter. Snapshot deduplication belongs to the observer. */
export function formatProgress(
  frame: typeof RunWatchFrame.Type
): string | undefined {
  if (frame._tag === "Heartbeat") {
    return;
  }
  if (frame._tag === "Snapshot") {
    const { run } = frame;
    return bounded(
      `Run ${run.runId} — ${run.kind} ${run.targetId} — snapshot ${run.status} at #${run.lastSequence}`
    );
  }
  const { event } = frame;
  return bounded(
    `#${event.sequence} ${event.at} ${event.tag}${details(event.tag, event.payload)}${event.tag === "NeedsAttention" ? ` — assess run recover ${event.runId}` : ""}`
  );
}

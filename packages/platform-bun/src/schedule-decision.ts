import { Cron } from "effect";

export const scheduleGrace = 60_000;
export const missedCountCap = 10_000;
const nextSlot = (cron: Cron.Cron, after: number) =>
  Cron.next(cron, new Date(after)).getTime();

// Reverse search can throw inside spring gaps in Effect 4.0.5. Walk a window
// containing the transition forwards before using reverse search for older slots.
function latestBefore(cron: Cron.Cron, now: number, lowerBound: number) {
  let cursor = nextSlot(cron, Math.max(lowerBound, now - 2 * 86_400_000));
  let latest: number | undefined;
  while (cursor <= now) {
    latest = cursor;
    cursor = nextSlot(cron, cursor);
  }
  // Cron.prev truncates milliseconds before stepping backwards one second.
  return (
    latest ??
    Cron.prev(cron, new Date(Math.floor(now / 1000) * 1000 + 1000)).getTime()
  );
}

/** Every instant is supplied by Effect Clock; count work is capped on long outages. */
export function dueSlots(
  cron: Cron.Cron,
  watermark: number,
  now: number,
  pending: number | null = null
) {
  if (now <= watermark) {
    return null;
  }
  // A failed spring-gap admission must retain its UTC identity: next() from
  // just before a shifted occurrence can already see the next wall-clock day.
  const first =
    pending !== null && pending > watermark
      ? pending
      : nextSlot(cron, watermark);
  if (first > now) {
    return null;
  }
  let count = 1;
  let latest = first;
  let previous = first;
  let following = nextSlot(cron, latest);
  while (following <= now && count < missedCountCap) {
    previous = latest;
    latest = following;
    count += 1;
    following = nextSlot(cron, latest);
  }
  const saturated = following <= now;
  if (saturated) {
    latest = latestBefore(cron, now, latest);
    previous = latestBefore(cron, latest - 1, first - 1000);
  }
  return {
    count,
    first,
    latest,
    olderSaturated: saturated && latest > following,
    previous,
    saturated,
  };
}
export function eligibility(
  now: number,
  scheduledFor: number,
  catchUpMillis: number | null
) {
  const age = now - scheduledFor;
  if (age < 0) {
    return "future";
  }
  if (age <= scheduleGrace) {
    return "on-time";
  }
  return catchUpMillis !== null && age <= catchUpMillis ? "catch-up" : "missed";
}

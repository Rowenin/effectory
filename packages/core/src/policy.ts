import { DefinitionError } from "./errors.ts";

/** Persisted policies use a bounded duration vocabulary, independent of an Effect Schedule. */
export function durationMillis(text: string, allowZero = false): number {
  const match =
    /^(?<amount>\d+(?:\.\d+)?) (?<unit>milli|millis|millisecond|milliseconds|second|seconds|minute|minutes|hour|hours|day|days|week|weeks)$/u.exec(
      text
    );
  const units: Record<string, number> = {
    day: 86_400_000,
    days: 86_400_000,
    hour: 3_600_000,
    hours: 3_600_000,
    milli: 1,
    millis: 1,
    millisecond: 1,
    milliseconds: 1,
    minute: 60_000,
    minutes: 60_000,
    second: 1000,
    seconds: 1000,
    week: 604_800_000,
    weeks: 604_800_000,
  };
  const unit = match?.groups?.unit;
  const amount =
    Number(match?.groups?.amount) * (unit ? (units[unit] ?? 0) : 0);
  if (
    !match ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    (!allowZero && amount === 0) ||
    amount > 365 * 86_400_000
  ) {
    throw new DefinitionError({
      message:
        "Duration must be positive (or zero for sleep) and at most 365 days",
    });
  }
  return amount;
}

export function boundedInteger(value: number, maximum: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new DefinitionError({
      message: `${name} must be an integer between 1 and ${maximum}`,
    });
  }
  return value;
}

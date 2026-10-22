import { Schema } from "effect";

/** Authoring codecs must be usable by admission, persistence, and inspection without services. */
export interface Codec extends Schema.Top {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
}

/** Framework failures are included alongside each definition's declared domain errors. */
// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError is a schema class factory, not an Error constructor.
export class AutomationError extends Schema.TaggedError<
  AutomationError,
  { readonly brand: unique symbol }
>()("AutomationError", {
  message: Schema.String,
  operation: Schema.String,
  reason: Schema.Literals([
    "invalid-input",
    "invalid-output",
    "approval-rejected",
    "runtime",
  ]),
}) {}

export const requireName = (name: string) => {
  if (!name.trim() || name.length > 128) {
    throw new Error("Definition names must contain 1 to 128 characters");
  }
};

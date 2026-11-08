import { Schema } from "effect";

import { Severity } from "./check-schema.ts";

// oxlint-disable-next-line unicorn/throw-new-error -- Schema factory, not an Error constructor.
export class AssertionFailed extends Schema.TaggedError<
  AssertionFailed,
  { readonly brand: unique symbol }
>()("AssertionFailed", {
  id: Schema.String,
  message: Schema.String,
  severity: Severity,
}) {}

import { CheckRecord } from "@offtree/effectory-sdk/internal/check-schema";
import { Schema } from "effect";

import { Cursor, Id, PageLimit } from "./history-protocol.ts";

export { CheckRecord } from "@offtree/effectory-sdk/internal/check-schema";
export const CheckListRequest = Schema.Struct({
  attempts: Schema.optionalKey(Schema.Literals(["latest", "all"])),
  cursor: Schema.optionalKey(Cursor),
  limit: Schema.optionalKey(PageLimit),
  runId: Id,
});
export const CheckPage = Schema.Struct({
  cursor: Schema.NullOr(Cursor),
  items: Schema.Array(CheckRecord).check(Schema.isMaxLength(200)),
  snapshot: Schema.Int,
});

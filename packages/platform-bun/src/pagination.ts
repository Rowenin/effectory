import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { canonical } from "@effectory/core/internal/boundary";
import { OperationError } from "@effectory/runtime/protocol";
import { Schema } from "effect";

const Token = Schema.Struct({
  expires: Schema.Finite,
  fingerprint: Schema.String,
  position: Schema.Json,
  snapshot: Schema.Json,
});
export interface PageScope {
  readonly kind: string;
  readonly principal: string;
  readonly query: Schema.Json;
}
const fingerprint = (scope: PageScope) =>
  createHash("sha256")
    .update(canonical({ ...scope }))
    .digest("hex");
const invalid = () =>
  new OperationError({ code: "InvalidInput", message: "Invalid page cursor" });
export function createPagination(secret: string) {
  const read = (scope: PageScope, cursor?: string) => {
    if (cursor === undefined) {
      return null;
    }
    if (cursor.length > 4096) {
      throw invalid();
    }
    const parts = cursor.split(".");
    const [body, signature] = parts;
    if (!body || !signature || parts.length !== 2) {
      throw invalid();
    }
    const expected = createHmac("sha256", secret).update(body).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw invalid();
    }
    let token: typeof Token.Type;
    try {
      token = Schema.decodeUnknownSync(Token)(
        JSON.parse(Buffer.from(body, "base64url").toString()),
        { onExcessProperty: "error" }
      );
    } catch {
      throw invalid();
    }
    if (token.expires <= Date.now()) {
      throw new OperationError({
        code: "CursorExpired",
        message: "Page cursor expired",
      });
    }
    if (token.fingerprint !== fingerprint(scope)) {
      throw new OperationError({
        code: "Conflict",
        message: "Cursor belongs to another query or principal",
      });
    }
    return token;
  };
  const write = (
    scope: PageScope,
    snapshot: Schema.Json,
    position: Schema.Json,
    expires: number
  ) => {
    const body = Buffer.from(
      canonical({
        expires,
        fingerprint: fingerprint(scope),
        position,
        snapshot,
      })
    ).toString("base64url");
    const token = `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
    if (token.length > 4096) {
      throw new OperationError({
        code: "LimitExceeded",
        message: "Page cursor exceeds 4 KiB",
      });
    }
    return token;
  };
  return { read, write };
}

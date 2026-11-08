import { Effect } from "effect";
import { HttpEffect } from "effect/http";

/**
 * Effect's web adapter masks interruption around request handling. Restore it
 * while waiting for RPC output so a disconnect closes the request scope even
 * before the first response. Acquisition and finalizers keep their own masks.
 */
export const rpcWebHandler: typeof HttpEffect.toWebHandler = (http) =>
  HttpEffect.toWebHandler(http.pipe(Effect.interruptible));

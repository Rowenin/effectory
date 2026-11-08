import { Context } from "effect";
import type { Effect } from "effect";

import type { AssertionFailed } from "./assertion-failed.ts";
import type { Severity } from "./check-schema.ts";
import type { TaskRuntimeError } from "./errors.ts";

export class Checks extends Context.Service<
  Checks,
  {
    readonly assert: <E, R>(
      id: string,
      predicate: Effect.Effect<boolean, E, R>,
      options: { readonly message: string; readonly severity?: Severity }
    ) => Effect.Effect<void, E | AssertionFailed | TaskRuntimeError, R>;
  }
>()("@offtree/effectory-sdk/Checks") {}

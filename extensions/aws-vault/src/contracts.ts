import { DefinitionError } from "@offtree/effectory-sdk";
import type { Vault } from "@offtree/effectory-sdk";
import { Effect } from "effect";

import { capture } from "./options.ts";
import type { Options } from "./options.ts";

export type { Options, SecretReference } from "./options.ts";

export const make = (
  options: Options
): Vault.Implementation<DefinitionError> => {
  const captured = capture(options);
  return (spec) =>
    Effect.gen(function* () {
      if (
        spec.keys.length !== Object.keys(captured.secrets).length ||
        spec.keys.some((name) => !Object.hasOwn(captured.secrets, name))
      ) {
        return yield* new DefinitionError({
          message: `AWS vault mappings must match every declared key of ${spec.id}`,
        });
      }
      const provider = yield* Effect.tryPromise({
        catch: () =>
          new DefinitionError({
            message: "AWS vault extension provider could not be loaded",
          }),
        try: () => import("./provider.ts"),
      });
      return yield* provider.makeBackend(spec, captured);
    });
};

export const contracts = Object.freeze({
  artifacts: {},
  id: "offtree/aws-vault",
  make,
  tasks: {},
  version: "0.1.0",
  workflows: {},
});

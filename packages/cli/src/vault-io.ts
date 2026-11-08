/* oxlint-disable promise/avoid-new, promise/prefer-await-to-callbacks -- Node writable callback bridged to Effect. */
import {
  createReadStream,
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isatty } from "node:tty";

import { OperationError } from "@effectory/runtime/protocol";
import { Effect } from "effect";

import {
  ownershipLayer,
  RepositoryLease,
} from "../../platform-bun/src/ownership.ts";
import { assertRuntimeWriter } from "../../platform-bun/src/runtime-writer-guard.ts";
import {
  makeVaultStore,
  outsideRepository,
  vaultOperation,
} from "../../platform-bun/src/vault-store.ts";
import type { VaultStore } from "../../platform-bun/src/vault-store.ts";

const invalid = (message: string) =>
  new OperationError({ code: "InvalidInput", message });
export function readSecret(filename: string) {
  return Effect.acquireUseRelease(
    Effect.try({
      catch: () =>
        invalid(
          "Cannot read secret input; use a regular file or pipe, never a terminal"
        ),
      try: () => {
        const fd = filename === "-" ? 0 : openSync(filename, "r");
        try {
          const stat = fstatSync(fd);
          if (isatty(fd) || (!stat.isFile() && !stat.isFIFO())) {
            throw invalid(
              "Secret input must be a regular file or pipe, never a terminal"
            );
          }
          return fd;
        } catch (error) {
          if (fd !== 0) {
            closeSync(fd);
          }
          throw error;
        }
      },
    }),
    (fd) =>
      Effect.tryPromise({
        catch: (error) =>
          error instanceof OperationError
            ? error
            : invalid(
                "Secret input must contain valid UTF-8 and be at most 64 KiB"
              ),
        try: async (signal) => {
          const stream = createReadStream("", {
            autoClose: false,
            fd,
            highWaterMark: 65_537,
            signal,
          });
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of stream) {
            const value: unknown = chunk;
            const buffer = Buffer.isBuffer(value)
              ? value
              : Buffer.from(String(value));
            bytes += buffer.byteLength;
            if (bytes > 65_536) {
              stream.destroy();
              throw invalid("Secret value exceeds 64 KiB");
            }
            chunks.push(buffer);
          }
          return new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks)
          );
        },
      }),
    (fd) =>
      Effect.sync(() => {
        if (fd !== 0) {
          closeSync(fd);
        }
      })
  );
}
export const writeSecret = (
  repository: string,
  value: string,
  output?: string
) =>
  output === undefined
    ? Effect.tryPromise({
        catch: () =>
          new OperationError({
            code: "Unavailable",
            message: "Secret output could not be written",
          }),
        try: async () =>
          await new Promise<void>((resolve, reject) => {
            process.stdout.write(value, (error) =>
              error ? reject(error) : resolve()
            );
          }),
      })
    : vaultOperation(() => {
        const filename = outsideRepository(repository, output);
        const fd = openSync(filename, "wx", 0o600);
        try {
          writeFileSync(fd, value, "utf-8");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      });
export function offlineVault<A>(
  repository: string,
  action: (store: VaultStore) => A
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* RepositoryLease;
      yield* vaultOperation(() => {
        lease.assertActive();
        assertRuntimeWriter(path.resolve(repository));
      });
      const store = yield* makeVaultStore(path.resolve(repository), lease);
      return yield* vaultOperation(() => action(store));
    }).pipe(
      Effect.provide(
        ownershipLayer(
          path.join(path.resolve(repository), ".effectory/state.sqlite.owner")
        )
      )
    )
  );
}

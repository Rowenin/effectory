/* oxlint-disable no-bitwise -- POSIX descriptor flags prevent following substituted record files. */
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { OperationError } from "@effectory/runtime/protocol";

export const upgradeRecordFailure = (message: string) =>
  new OperationError({ code: "RevisionUnavailable", message });
export const missingUpgradeFile = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  Reflect.get(cause, "code") === "ENOENT";

export function flushUpgradePath(filename: string) {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function upgradeDirectory(directory: string, create: boolean) {
  try {
    if (!lstatSync(directory).isDirectory()) {
      throw upgradeRecordFailure("Upgrade records require real directories");
    }
    return true;
  } catch (error) {
    if (!missingUpgradeFile(error)) {
      throw error;
    }
    if (!create) {
      return false;
    }
    mkdirSync(directory, { mode: 0o700 });
    flushUpgradePath(path.dirname(directory));
    return true;
  }
}
function regular(filename: string, maximum: number) {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) {
    throw upgradeRecordFailure(
      "Upgrade records must be bounded, single-link regular files"
    );
  }
  return stat;
}
export function readUpgradeFile(
  filename: string,
  maximum: number
): string | null {
  let initial;
  try {
    initial = regular(filename, maximum);
  } catch (error) {
    if (missingUpgradeFile(error)) {
      return null;
    }
    throw error;
  }
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      stat.ino !== initial.ino ||
      stat.dev !== initial.dev ||
      stat.nlink !== 1
    ) {
      throw upgradeRecordFailure("Upgrade record changed while being opened");
    }
    const buffer = Buffer.alloc(Math.min(maximum + 1, stat.size + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) {
        break;
      }
      offset += count;
    }
    const final = fstatSync(fd);
    if (
      offset !== stat.size ||
      final.size !== stat.size ||
      final.mtimeMs !== stat.mtimeMs
    ) {
      throw upgradeRecordFailure("Upgrade record changed while being read");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, offset)
      );
    } catch {
      throw upgradeRecordFailure("Upgrade record contains invalid UTF-8");
    }
  } finally {
    closeSync(fd);
  }
}
/** A fixed private prepare file is non-authoritative and may be rewritten after a crash. */
export function writeUpgradeFile(
  filename: string,
  text: string,
  maximum: number,
  replace: boolean
) {
  if (Buffer.byteLength(text) > maximum) {
    throw new OperationError({
      code: "LimitExceeded",
      message: "Upgrade record exceeds its storage budget",
    });
  }
  const prior = readUpgradeFile(filename, maximum);
  if (!replace && prior !== null) {
    throw new OperationError({
      code: "Conflict",
      message: "Upgrade record already exists",
    });
  }
  const prepare = `${filename}.prepare`;
  try {
    regular(prepare, maximum);
  } catch (error) {
    if (!missingUpgradeFile(error)) {
      throw error;
    }
  }
  const fd = openSync(
    prepare,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600
  );
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maximum) {
      throw upgradeRecordFailure(
        "Upgrade prepare file changed while being opened"
      );
    }
    ftruncateSync(fd, 0);
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written === 0) {
        throw new Error("Upgrade record write made no progress");
      }
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(prepare, filename);
  flushUpgradePath(path.dirname(filename));
}
export function removeUpgradeFile(filename: string, maximum: number) {
  if (readUpgradeFile(filename, maximum) === null) {
    return;
  }
  unlinkSync(filename);
  flushUpgradePath(path.dirname(filename));
}

/**
 * Host-internal processes started by re-executing the binary with
 * `__effectory-internal <name> ...`. Source runs start the worker files
 * directly; this dispatcher exists so a compiled binary needs no files on disk.
 */
export async function runInternalCommand(args: readonly string[]) {
  const [name, ...rest] = args;
  if (name === "validate-extensions") {
    const { runValidationWorker } =
      await import("./extension-validate-worker.ts");
    await runValidationWorker(rest);
    return;
  }
  process.stderr.write(`Unknown internal command: ${String(name)}\n`);
  process.exitCode = 2;
}

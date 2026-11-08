/* oxlint-disable no-await-in-loop -- Poll the admitted run with a bounded deadline. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Run, terminal } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { cli, start } from "./fixtures/cli.ts";

test("a bundled task Layer can publish from a nested scoped binary source through the real lake", async () => {
  const repository = await mkdtemp(
    path.join(tmpdir(), "effectory-nested-publish-")
  );
  let daemon: Awaited<ReturnType<typeof start>> | undefined;
  try {
    await symlink(
      path.resolve(import.meta.dir, "../../../node_modules"),
      path.join(repository, "node_modules"),
      "dir"
    );
    await writeFile(
      path.join(repository, "effectory.ts"),
      `
import { Application, Artifact, ArtifactStorage, Task } from "@offtree/effectory-sdk";
import { Context, Effect, Layer, Schema, Stream } from "effect";
const Json = Artifact.make({ id: "nested/json", version: 1, schema: Schema.String });
const Bytes = Artifact.make({ id: "nested/bytes", version: 1, kind: "bytes", contentType: "application/octet-stream" });
class Ready extends Context.Service<Ready, typeof Bytes.refSchema.Type>()("nested/Ready") {}
const setup = Layer.effect(Ready, Effect.gen(function* () {
  const storage = yield* ArtifactStorage;
  const source = Stream.fromEffect(Effect.scoped(Effect.gen(function* () {
    yield* storage.publish(Json, "inner", { key: "inner" });
    return new Uint8Array([1, 2, 3]);
  })));
  return yield* storage.publish(Bytes, source, { key: "outer" });
}));
const task = Task.make({ id: "nested/publisher", version: 1, input: Schema.Null, success: Bytes.refSchema, error: Schema.Never, outputs: { json: Json, bytes: Bytes }, replay: "idempotent" }, () => Effect.gen(function* () {
  const result = yield* Ready;
  yield* (yield* ArtifactStorage).publish(Json, "after", { key: "after" });
  return result;
})).provide(setup);
export default Application.make({ tasks: [task] });
`
    );
    daemon = await start(repository);
    let run = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "task",
        "run",
        "nested/publisher",
        "--input",
        "null",
        "--background",
      ])
    );
    const deadline = Date.now() + 15_000;
    while (!terminal.has(run.status) && Date.now() < deadline) {
      await Bun.sleep(50);
      run = Schema.decodeUnknownSync(Run)(
        await cli(repository, ["run", "get", run.runId])
      );
    }
    expect(run.status).toBe("Succeeded");
    const reference = Schema.decodeUnknownSync(
      Schema.Struct({ artifactId: Schema.String, version: Schema.Int })
    )(run.result);
    const output = path.join(repository, "download.bin");
    await cli(repository, [
      "lake",
      "download",
      reference.artifactId,
      "--version",
      String(reference.version),
      "--output",
      output,
    ]);
    expect(new Uint8Array(await readFile(output))).toEqual(
      new Uint8Array([1, 2, 3])
    );
    await cli(repository, ["daemon", "stop"]);
    await daemon.exited;
    const db = new Database(path.join(repository, ".effectory/state.sqlite"), {
      readonly: true,
    });
    try {
      expect(
        db.query("SELECT count(*) AS count FROM lake_records").get()
      ).toEqual({ count: 3 });
    } finally {
      db.close();
    }
  } finally {
    if (daemon?.exitCode === null) {
      daemon.kill("SIGKILL");
    }
    if (daemon) {
      await daemon.exited;
    }
    await rm(repository, { force: true, recursive: true });
  }
}, 45_000);

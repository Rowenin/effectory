/* oxlint-disable no-await-in-loop -- CLI mutations and daemon lifecycle steps must remain ordered. */
import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ReclamationPlan } from "@effectory/runtime/lake-protocol";
import { Run } from "@effectory/runtime/protocol";
import { Schema } from "effect";

import { cli, effectory, start } from "./fixtures/cli.ts";

const Result = Schema.Struct({
  artifactId: Schema.String,
  version: Schema.Int,
});

async function rawCli(repository: string, args: readonly string[]) {
  const child = Bun.spawn(
    [...effectory, ...args, "--repository", repository, "--json"],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr, stdout };
}

test("bundled FileSystem bytes publish, download across restart/restore, and reclaim through CLI", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "effectory-binary-cli-"));
  let repository = path.join(directory, "original");
  const children: Awaited<ReturnType<typeof start>>[] = [];
  try {
    await mkdir(repository);
    // The application bundles its platform adapter; Effect and the SDK remain host-shared.
    await symlink(
      path.resolve(import.meta.dir, "../../../node_modules"),
      path.join(repository, "node_modules"),
      "dir"
    );
    await writeFile(
      path.join(repository, "effectory.ts"),
      `
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Application, Artifact, ArtifactStorage, Task } from "@offtree/effectory-sdk";
import { Effect, FileSystem, Schema, Stream } from "effect";
class ReadFailed extends Schema.TaggedError<ReadFailed>()("ReadFailed", { message: Schema.String }) {}
const File = Artifact.make({ id: "binary/file", version: 1, kind: "bytes", contentType: "application/octet-stream", retention: { maxVersions: 1 } });
const Write = Task.make({ id: "binary/write", version: 1, input: Schema.String, success: File.refSchema, error: ReadFailed, replay: "idempotent", outputs: { file: File } }, (source) => Effect.gen(function* () {
 const fs = yield* FileSystem.FileSystem;
 const storage = yield* ArtifactStorage;
 return yield* storage.publish(File, fs.stream(source).pipe(Stream.mapError((error) => new ReadFailed({ message: error.message }))), { key: "main" });
})).provide(BunFileSystem.layer);
export default Application.make({ tasks: [Write] });
`
    );
    const payload = new Uint8Array(1_048_583);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 256;
    }
    const source = path.join(directory, "source.bin");
    await writeFile(source, payload);
    const first = await start(repository);
    children.push(first);
    const endpoint = Schema.decodeSync(
      Schema.fromJsonString(Schema.Struct({ url: Schema.String }))
    )(await readFile(path.join(repository, ".effectory/daemon.json"), "utf-8"));
    const credentials = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({ repositoryId: Schema.String, token: Schema.String })
      )
    )(
      await readFile(
        path.join(repository, ".effectory/credentials.json"),
        "utf-8"
      )
    );
    const contentUrl = new URL("/rpc/content", endpoint.url);
    const unauthorized = await fetch(contentUrl, {
      body: "{}",
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);
    const invalidRequest = await fetch(contentUrl, {
      body: " ".repeat(16_385),
      headers: {
        authorization: `Bearer ${credentials.token}`,
        "x-effectory-protocol": "1",
        "x-effectory-repository": credentials.repositoryId,
      },
      method: "POST",
    });
    expect(invalidRequest.status).toBe(400);
    const description = Schema.decodeUnknownSync(
      Schema.Struct({
        outputs: Schema.Struct({
          file: Schema.Struct({
            contentType: Schema.String,
            kind: Schema.Literal("bytes"),
          }),
        }),
      })
    )(await cli(repository, ["task", "describe", "binary/write"]));
    expect(description.outputs.file.contentType).toBe(
      "application/octet-stream"
    );
    const submitted = Schema.decodeUnknownSync(Run)(
      await cli(repository, [
        "task",
        "run",
        "binary/write",
        "--input",
        JSON.stringify(source),
      ])
    );
    expect(submitted.status).toBe("Succeeded");
    const reference = Schema.decodeUnknownSync(Result)(submitted.result);
    const before = path.join(directory, "before.bin");
    await cli(repository, [
      "lake",
      "download",
      reference.artifactId,
      "--version",
      "1",
      "--output",
      before,
    ]);
    expect(new Uint8Array(await readFile(before))).toEqual(payload);
    const get = await rawCli(repository, [
      "lake",
      "get",
      reference.artifactId,
      "--version",
      "1",
    ]);
    expect(get.code).toBe(2);
    expect(get.stderr).toContain("lake download");
    const overwrite = await rawCli(repository, [
      "lake",
      "download",
      reference.artifactId,
      "--version",
      "1",
      "--output",
      before,
    ]);
    expect(overwrite.code).not.toBe(0);
    expect(overwrite.stderr).toContain("destination exists");
    first.kill("SIGKILL");
    await first.exited;
    const restarted = await start(repository);
    children.push(restarted);
    const after = path.join(directory, "after.bin");
    await cli(repository, [
      "lake",
      "download",
      reference.artifactId,
      "--version",
      "1",
      "--output",
      after,
    ]);
    expect(new Uint8Array(await readFile(after))).toEqual(payload);
    restarted.kill("SIGKILL");
    await restarted.exited;
    const snapshot = path.join(directory, "snapshot");
    await cli(repository, ["backup", snapshot]);
    repository = path.join(directory, "restored");
    await cli(repository, ["restore", snapshot]);
    // Generated dependencies are excluded by backup; restore the application's installed adapter.
    await symlink(
      path.resolve(import.meta.dir, "../../../node_modules"),
      path.join(repository, "node_modules"),
      "dir"
    );
    children.push(await start(repository));
    const restored = path.join(directory, "restored.bin");
    await cli(repository, [
      "lake",
      "download",
      reference.artifactId,
      "--version",
      "1",
      "--output",
      restored,
    ]);
    expect(new Uint8Array(await readFile(restored))).toEqual(payload);
    const plan = Schema.decodeUnknownSync(ReclamationPlan)(
      await cli(repository, [
        "lake",
        "reclaim",
        "plan",
        "--artifact",
        reference.artifactId,
        "--version",
        "1",
      ])
    );
    await cli(repository, ["lake", "reclaim", "apply", plan.planId]);
    const gone = await rawCli(repository, [
      "lake",
      "download",
      reference.artifactId,
      "--version",
      "1",
      "--output",
      path.join(directory, "gone.bin"),
    ]);
    expect(gone.code).not.toBe(0);
    expect(gone.stderr).toContain("reclaimed");
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 120_000);

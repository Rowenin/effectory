import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BunServices } from "@effect/platform-bun";
import { Task } from "@offtree/effectory-sdk";
import { Effect, Layer, Schema } from "effect";

import { verifyArchive } from "../../../packages/platform-bun/src/extension-archive.ts";
import { validateExports } from "../../../packages/platform-bun/src/extension-validation.ts";
import {
  typescript,
  workspace,
} from "../../../packages/platform-bun/test/fixtures/published-extension.ts";
import { buildAgentRunnerExtension } from "../build.ts";
import type * as ContractModule from "../src/contracts.ts";
import type * as ExtensionModule from "../src/extension.ts";

test("archive loads canonical contracts and preserves service requirements in consumer declarations", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "effectory-agent-archive-")
  );
  try {
    const built = await buildAgentRunnerExtension(directory);
    const archive = verifyArchive(await readFile(built.archive));
    expect(archive.manifest.contributions.tasks).toEqual([
      {
        id: "offtree/agent-runner/run-session",
        name: "RunSession",
        version: 1,
      },
    ]);
    expect(
      archive.manifest.dependencyInventory.map((dependency) => dependency.name)
    ).toContain("@distilled.cloud/opencode");
    await Promise.all(
      [...archive.files].map(async ([name, bytes]) => {
        await writeFile(path.join(directory, name), bytes);
      })
    );
    await symlink(
      path.join(workspace, "node_modules"),
      path.join(directory, "node_modules"),
      "dir"
    );
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- The verified archive is checked by validateExports before its exports are executed.
    const contracts: typeof ContractModule = await import(
      pathToFileURL(path.join(directory, "contracts.mjs")).href
    );
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- The verified archive is checked by validateExports before its exports are executed.
    const implementation: typeof ExtensionModule = await import(
      pathToFileURL(path.join(directory, "extension.mjs")).href
    );
    await validateExports(
      archive.manifest,
      contracts,
      implementation,
      archive.archiveDigest
    );
    const executed = await Effect.runPromise(
      Task.test(implementation.default.tasks.RunSession, {
        input: {
          platform: "fixture",
          policy: "read",
          prompt: "test packaged execution",
          workingDirectory: directory,
        },
      }).pipe(
        Effect.provide(
          contracts
            .layer({
              adapters: {
                fixture: {
                  configuration: "fixture",
                  run: () =>
                    Effect.succeed({
                      output: "packaged",
                      transcript: [],
                      version: "fixture",
                    }),
                  supportsResume: false,
                },
              },
              policies: { read: {} },
            })
            .pipe(Layer.provide(BunServices.layer))
        )
      )
    );
    expect(executed.value.output).toBe("packaged");
    expect(executed.publications).toHaveLength(1);
    const typed = contracts.makeTask({
      id: "fixture/packaged-json",
      output: Schema.Struct({ ok: Schema.Boolean }),
      version: 1,
    });
    const json = await Effect.runPromise(
      Task.test(typed, {
        input: {
          platform: "fixture",
          policy: "read",
          prompt: "json",
          workingDirectory: directory,
        },
      }).pipe(
        Effect.provide(
          contracts
            .layer({
              adapters: {
                fixture: {
                  configuration: "fixture",
                  run: (request) =>
                    Effect.succeed({
                      output: JSON.stringify({
                        output: { ok: request.outputSchema !== undefined },
                      }),
                      transcript: [],
                      version: "fixture",
                    }),
                  supportsResume: false,
                  supportsStructuredOutput: true,
                },
              },
              policies: { read: {} },
            })
            .pipe(Layer.provide(BunServices.layer))
        )
      )
    );
    expect(json.value.output.ok).toBe(true);
    expect(json.publications[0]?.value).toMatchObject({ output: { ok: true } });
    await writeFile(
      path.join(directory, "consumer.ts"),
      `
import { Application, Extension } from "@offtree/effectory-sdk";
import { BunServices } from "@effect/platform-bun";
import { Context, Effect, Layer, Schema } from "effect";
import { contracts } from "./contracts.mjs";
import extension from "./extension.mjs";
const installed = Extension.installed(contracts, async () => extension, "${archive.archiveDigest}");
// @ts-expect-error Selected tasks retain the AgentRunner service requirement.
const missing: Application.Application<never> = Application.make({ extensions: [Extension.use(installed)] });
export default Application.make({ extensions: [Extension.use(installed)] }).provide(installed.exports.layer({ policies: {} }).pipe(Layer.provide(BunServices.layer))) satisfies Application.Application<never>;
void missing;
class Credentials extends Context.Service<Credentials, { readonly token: string }>()("fixture/Credentials") {}
const credentialsRequired = installed.exports.layer({
  platforms: { claude: { kind: "claude", configuration: "fixture", executable: "/agent", version: "1.0.0", environment: Effect.map(Credentials, (credentials) => ({ TOKEN: credentials.token })) } },
  policies: {},
}).pipe(Layer.provide(BunServices.layer));
// @ts-expect-error Credential services remain required after providing the runner.
const missingCredentials: Application.Application<never> = Application.make({ extensions: [Extension.use(installed)] }).provide(credentialsRequired);
void missingCredentials;
const Review = installed.exports.makeTask({ id: "fixture/review", version: 1, output: Schema.Struct({ ok: Schema.Boolean }) });
const correct: typeof Review.successSchema.Type.output = { ok: true };
// @ts-expect-error Output fields retain the Effect Schema type.
const wrong: typeof Review.successSchema.Type.output = { ok: "yes" };
// @ts-expect-error Structured outputs are not widened to text.
const text: typeof Review.successSchema.Type.output = "yes";
// @ts-expect-error Typed task handlers require AgentRunner.
const missingRunner: Application.Application<never> = Application.make({ tasks: [Review] });
const app: Application.Application<never> = Application.make({ tasks: [Review] }).provide(installed.exports.layer({ policies: {} }).pipe(Layer.provide(BunServices.layer)));
void [correct, wrong, text, missingRunner, app];
`
    );
    await typescript(directory, ["consumer.ts"]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

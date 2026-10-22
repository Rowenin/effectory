import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
export const packageVersion = () => {
  const manifests = ["sdk", "activities", "runtime", "cli"].map((name) => {
    const metadata = JSON.parse(
      readFileSync(path.join(root, "packages", name, "package.json"), "utf-8")
    ) as {
      name: string;
      version: string;
      dependencies: Record<string, string>;
    };
    if (metadata.name !== `@effectory/${name}`) {
      throw new Error(`Unexpected package name: ${metadata.name}`);
    }
    return metadata;
  });
  const versions = manifests.map((metadata) => metadata.version);
  const [version] = versions;
  if (
    !version ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(version) ||
    versions.some((value) => value !== version)
  ) {
    throw new Error(
      "SDK, activities, runtime, and CLI must share a valid release version"
    );
  }
  for (const metadata of manifests) {
    for (const [name, pin] of Object.entries(metadata.dependencies)) {
      if (
        name.startsWith("@effectory/") &&
        (pin !== version || !manifests.some((pkg) => pkg.name === name))
      ) {
        throw new Error(
          `${metadata.name}: ${name} must pin a released package at ${version}`
        );
      }
    }
  }
  return version;
};

export const packPackages = (destination = path.join(root, "dist")) => {
  packageVersion();
  mkdirSync(destination, { recursive: true });
  for (const name of ["sdk", "activities", "runtime", "cli"]) {
    const result = Bun.spawnSync(
      [process.execPath, "pm", "pack", "--destination", destination],
      {
        cwd: path.join(root, "packages", name),
        stderr: "inherit",
        stdout: "inherit",
      }
    );
    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  }
};

if (import.meta.main) {
  packPackages();
}

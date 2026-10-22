#!/bin/sh
set -eu

repository=${EFFECTORY_REPOSITORY:-cypress-io/effectory}
release_tag=${EFFECTORY_VERSION:-@EFFECTORY_RELEASE_TAG@}
install_dir=${EFFECTORY_INSTALL_DIR:-${XDG_DATA_HOME:-"$HOME/.local/share"}/effectory}
bin_dir=${EFFECTORY_BIN_DIR:-"$HOME/.local/bin"}
workspace=
download_dir=
created_dir=
wrapper=

die() {
  printf '%s\n' "effectory: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Install the Effectory CLI from a GitHub release (macOS or Linux).

Usage: sh install.sh [options]
  --version TAG       Release to install (defaults to this installer's release)
  --workspace PATH    Also install this release's SDK and dependencies into a repo
  --install-dir PATH  CLI data directory (default: ~/.local/share/effectory)
  --bin-dir PATH      Command directory (default: ~/.local/bin)
  --repo OWNER/REPO   GitHub repository (default: cypress-io/effectory)
  --help              Show this help

Requires Bun 1.4.3+, Node 24.11.1+, and an authenticated GitHub CLI (gh).
The installer does not change your shell profile or install these prerequisites.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --version|--workspace|--install-dir|--bin-dir|--repo)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        die "$1 requires a value"
      fi
      case "$1" in
        --version) release_tag=$2 ;;
        --workspace) workspace=$2 ;;
        --install-dir) install_dir=$2 ;;
        --bin-dir) bin_dir=$2 ;;
        --repo) repository=$2 ;;
      esac
      shift 2
      ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "This installer supports macOS and Linux" ;;
esac
case "$release_tag" in v*) ;; *) release_tag="v$release_tag" ;; esac
printf '%s\n' "$release_tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$' ||
  die "Expected a release tag such as v0.1.2; use --version when running from a checkout"
printf '%s\n' "$repository" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$' ||
  die "Expected --repo OWNER/REPO"
if [ -n "$workspace" ]; then
  [ -d "$workspace" ] || die "The workspace must be an existing directory"
  workspace=$(cd "$workspace" && pwd -P)
fi
for prerequisite in bun node gh; do
  command -v "$prerequisite" >/dev/null 2>&1 || die "Install $prerequisite before running this installer"
done
bun_path=$(command -v bun)
node -e '
const atLeast = (value, minimum) => {
  const parts = value.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < minimum.length; i++) {
    if (parts[i] > minimum[i]) return true;
    if (!Number.isFinite(parts[i]) || parts[i] < minimum[i]) return false;
  }
  return true;
};
if (!atLeast(process.versions.node, [24, 11, 1]) || !atLeast(process.argv[1], [1, 4, 3])) {
  console.error("effectory: Bun 1.4.3+ and Node 24.11.1+ are required");
  process.exit(1);
}
' "$("$bun_path" --version)"

cleanup() {
  [ -z "$download_dir" ] || rm -rf "$download_dir"
  [ -z "$created_dir" ] || rm -rf "$created_dir"
  [ -z "$wrapper" ] || rm -f "$wrapper"
}
trap cleanup 0
trap 'exit 1' 1 2 3 15
umask 077
download_dir=$(mktemp -d "${TMPDIR:-/tmp}/effectory-download.XXXXXX")
release_version=${release_tag#v}
archive="effectory-$release_tag.tar.gz"
printf 'Downloading Effectory %s...\n' "$release_version"
gh release download "$release_tag" --repo "$repository" --dir "$download_dir" \
  --pattern "$archive" --pattern SHA256SUMS ||
  die "Could not download $release_tag; authenticate with gh auth login and check repository access"
expected=$(awk -v name="$archive" '$2 == name { print $1 }' "$download_dir/SHA256SUMS")
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$download_dir/$archive" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$download_dir/$archive" | awk '{ print $1 }')
fi
if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
  die "Release archive checksum mismatch"
fi
tar -xzf "$download_dir/$archive" -C "$download_dir"
bundle="$download_dir/effectory-$release_tag"
[ -f "$bundle/install.ts" ] || die "Release archive is missing its installer"
mkdir -p "$install_dir" "$bin_dir"
install_dir=$(cd "$install_dir" && pwd -P)
bin_dir=$(cd "$bin_dir" && pwd -P)
version_dir="$install_dir/$release_tag-$actual"
if mkdir "$version_dir" 2>/dev/null; then
  created_dir=$version_dir
  cp -R "$bundle" "$version_dir/bundle"
  printf 'Installing Effectory %s...\n' "$release_version"
  if ! "$bun_path" "$version_dir/bundle/install.ts" "$version_dir" >"$download_dir/install.log" 2>&1; then
    cat "$download_dir/install.log" >&2
    die "CLI installation failed"
  fi
  "$bun_path" --no-install "$version_dir/.effectory/node_modules/.bin/effectory" --version
  : >"$version_dir/.complete"
  created_dir=
else
  [ -f "$version_dir/.complete" ] || die "An installation is already in progress or the release directory is incomplete: $version_dir"
fi

# Load only one Effect dependency graph: prefer the requested workspace's CLI.
# Importing the global runtime and a workspace SDK into one process can mix
# schema registrations from different installations of Effect.
cat >"$download_dir/launch.mjs" <<'LAUNCHER'
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
let workspace = process.cwd();
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === "--") break;
  if (argument === "--workspace" && args[index + 1] && !args[index + 1].startsWith("-")) {
    workspace = args[++index];
  } else if (argument.startsWith("--workspace=")) {
    workspace = argument.slice("--workspace=".length);
  }
}
const directory = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(workspace, ".effectory/node_modules/@effectory/cli/src/main.ts"),
  path.resolve(workspace, "node_modules/@effectory/cli/src/main.ts"),
  path.join(directory, ".effectory/node_modules/@effectory/cli/src/main.ts"),
];
const entry = candidates.find((filename) => existsSync(filename));
if (!entry) throw new Error("Effectory CLI installation is incomplete; rerun install.sh");
await import(pathToFileURL(entry).href);
LAUNCHER
mv -f "$download_dir/launch.mjs" "$version_dir/launch.mjs"

# Quote literal paths, including spaces, apostrophes, dollar signs, and backticks.
shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}
[ ! -d "$bin_dir/effectory" ] || die "$bin_dir/effectory is a directory"
wrapper=$(mktemp "$bin_dir/.effectory.XXXXXX")
{
  printf '#!/bin/sh\nexec '
  shell_quote "$bun_path"
  printf ' --no-install '
  shell_quote "$version_dir/launch.mjs"
  printf ' "$@"\n'
} >"$wrapper"
chmod 755 "$wrapper"
mv -f "$wrapper" "$bin_dir/effectory"
wrapper=
if [ -n "$workspace" ]; then
  if ! "$bun_path" "$version_dir/bundle/install.ts" "$workspace" >"$download_dir/workspace.log" 2>&1; then
    cat "$download_dir/workspace.log" >&2
    die "CLI installed, but workspace setup failed"
  fi
  printf 'Prepared workspace %s\n' "$workspace"
fi
printf 'Installed %s\n' "$bin_dir/effectory"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    printf 'Add this directory to your PATH:\n  export PATH='
    shell_quote "$bin_dir"
    # Print a literal PATH reference for the user's shell profile.
    # shellcheck disable=SC2016
    printf ':"$PATH"\n'
    ;;
esac
printf 'Run effectory --help to get started. Use --workspace PATH to prepare a repository too.\n'

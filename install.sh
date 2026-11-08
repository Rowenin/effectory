#!/bin/sh
# Installs the Effectory binary from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/Rowenin/effectory/main/install.sh | sh
#   curl -fsSL … | EFFECTORY_VERSION=0.1.0 sh
#
# EFFECTORY_VERSION  release to install (default: latest)
# EFFECTORY_HOME     install root; the binary goes in $EFFECTORY_HOME/bin
#                    (default: ~/.effectory)
# EFFECTORY_DOWNLOAD_BASE  directory or mirror holding the release assets
set -eu

repo="Rowenin/effectory"
version="${EFFECTORY_VERSION:-latest}"
home="${EFFECTORY_HOME:-$HOME/.effectory}"
bin_dir="$home/bin"

fail() {
  echo "effectory install: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) fail "unsupported operating system $(uname -s); download a binary from https://github.com/$repo/releases" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

# An x64 shell under Rosetta still runs on Apple silicon.
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] &&
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  arch="arm64"
fi

suffix=""
if [ "$os" = "linux" ]; then
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 || true) | grep -qi musl; then
    suffix="-musl"
  fi
fi

asset="effectory-$os-$arch$suffix"
case "$version" in
  latest) base="https://github.com/$repo/releases/latest/download" ;;
  v*) base="https://github.com/$repo/releases/download/$version" ;;
  *) base="https://github.com/$repo/releases/download/v$version" ;;
esac
base="${EFFECTORY_DOWNLOAD_BASE:-$base}"

command -v curl >/dev/null 2>&1 || fail "curl is required"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $asset ($version)…"
curl -fsSL --retry 3 -o "$tmp/$asset" "$base/$asset" ||
  fail "could not download $base/$asset"
curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" ||
  fail "could not download $base/SHA256SUMS"

expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
else
  fail "sha256sum or shasum is required to verify the download"
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset"

mkdir -p "$bin_dir"
chmod +x "$tmp/$asset"
mv "$tmp/$asset" "$bin_dir/effectory"

echo "Installed $asset ($version) to $bin_dir/effectory"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    echo
    echo "Add Effectory to your PATH, for example in ~/.zshrc or ~/.bashrc:"
    echo "  export PATH=\"$bin_dir:\$PATH\""
    ;;
esac

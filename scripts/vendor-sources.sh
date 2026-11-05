#!/usr/bin/env bash
# Reproduce the read-only source checkouts recorded in vendor/manifest.json.
set -euo pipefail
cd "$(dirname "$0")/.."
clone_at() {
  local name="$1" url="$2" revision="$3"
  local destination="vendor/$name"
  if [[ -e "$destination" ]]; then
    if [[ "$(git -C "$destination" rev-parse HEAD)" != "$revision" ]]; then
      echo "Refusing to replace $destination: revision differs from manifest" >&2
      exit 1
    fi
    if [[ -n "$(git -C "$destination" status --porcelain)" ]]; then
      echo "Refusing modified source reference: $destination" >&2
      exit 1
    fi
    return
  fi
  git init "$destination"
  git -C "$destination" remote add origin "$url"
  git -C "$destination" fetch --depth 1 origin "$revision"
  git -C "$destination" checkout --detach FETCH_HEAD
}
mkdir -p vendor
clone_at swamp https://github.com/swamp-club/swamp.git b42dd1ac63c899e1cba75efae9d7d3dd1ce96c11
clone_at effect https://github.com/Effect-TS/effect.git 7f524e25cfb49a71ac39b0f44278d08d40dda5de

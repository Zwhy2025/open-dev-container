#!/usr/bin/env bash

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dist_dir="$root_dir/dist"
package_name="$(node -e "const p=require(process.argv[1]); process.stdout.write(p.name)" "$root_dir/package.json")"
package_version="$(node -e "const p=require(process.argv[1]); process.stdout.write(p.version)" "$root_dir/package.json")"
vsix_file="$package_name-$package_version.vsix"
vsix_path="$dist_dir/$vsix_file"

command="${1:-}"

usage() {
  cat <<EOF
Usage: bash ./infra.sh [command]

Commands:
  lib_update  Install npm dependencies with npm ci
  build       Compile TypeScript to out/
  pack        Package the extension to dist/${vsix_file}
  pack-debug  Compile and package a uniquely identified local debug build
  all         Run lib_update, build, then pack

If no command is provided, infra.sh runs the full flow: lib_update -> build -> pack.
EOF
}

run_root() {
  (cd "$root_dir" && "$@")
}

require_node_modules() {
  if [[ ! -d "$root_dir/node_modules" ]]; then
    echo "node_modules is missing. Run 'bash ./infra.sh lib_update' first." >&2
    exit 1
  fi
}

require_vsce() {
  if [[ ! -x "$root_dir/node_modules/.bin/vsce" ]]; then
    echo "vsce is missing. Run 'npm ci' first." >&2
    exit 1
  fi
}

do_lib_update() {
  run_root npm ci
}

do_build() {
  require_node_modules
  run_root npm run compile
}

do_pack() {
  do_build
  require_vsce
  mkdir -p "$dist_dir"
  "$root_dir/node_modules/.bin/vsce" package --allow-missing-repository --out "$vsix_path"
}

do_all() {
  do_lib_update
  do_build
  do_pack
}

case "$command" in
  lib_update)
    do_lib_update
    ;;
  build)
    do_build
    ;;
  pack)
    do_pack
    ;;
  pack-debug)
    do_build
    require_vsce
    run_root node scripts/package-debug.js
    ;;
  all)
    do_all
    ;;
  -h|--help|help)
    usage
    ;;
  "")
    do_all
    ;;
  *)
    echo "Unknown infra command: $command" >&2
    usage >&2
    exit 1
    ;;
esac

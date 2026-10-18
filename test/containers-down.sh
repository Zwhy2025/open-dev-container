#!/usr/bin/env bash
# 删除 test/containers-up.sh 创建的 6 个测试容器（镜像保留）
# 用法: bash ./test/containers-down.sh
set -euo pipefail

VERSIONS=(20.04 22.04 24.04)

for v in "${VERSIONS[@]}"; do
  short="${v%%.*}"
  docker rm -f "odc-docker-u${short}" 2>/dev/null || true
  podman rm -f "odc-podman-u${short}" 2>/dev/null || true
done

echo ">> done, remaining odc-* containers:"
{ docker ps -a --filter 'name=odc-' --format '{{.Names}}'; podman ps -a --filter 'name=odc-' --format '{{.Names}}'; } | grep . || echo "(none)"

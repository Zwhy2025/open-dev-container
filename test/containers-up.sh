#!/usr/bin/env bash
# 创建扩展测试容器：ubuntu 20.04/22.04/24.04 × docker/podman 共 6 个
# 用法: bash ./test/containers-up.sh
set -euo pipefail

VERSIONS=(20.04 22.04 24.04)

for v in "${VERSIONS[@]}"; do
  short="${v%%.*}"
  img="docker.io/library/ubuntu:${v}"

  # podman 走已配置的镜像加速拉取
  if ! podman image exists "${img}"; then
    echo ">> podman pull ${img}"
    podman pull "${img}"
  fi

  # docker 未配加速，从 podman 存储导入（避免动 daemon 配置/重启）
  if ! docker image inspect "ubuntu:${v}" >/dev/null 2>&1; then
    echo ">> import ${img} into docker"
    podman save "${img}" | docker load
  fi

  docker rm -f "odc-docker-u${short}" >/dev/null 2>&1 || true
  podman rm -f "odc-podman-u${short}" >/dev/null 2>&1 || true

  docker run -d --name "odc-docker-u${short}" "ubuntu:${v}" sleep infinity
  podman run -d --name "odc-podman-u${short}" "${img}" sleep infinity
done

echo ">> done"
docker ps --filter 'name=odc-docker-' --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
podman ps --filter 'name=odc-podman-' --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'

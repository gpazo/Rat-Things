#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(dirname "$script_dir")"
image_tag="${MICROVM_E2E_IMAGE_TAG:-rat-things-microvm-e2e:local}"
container_name="rat-things-microvm-e2e-$$"
peer_name="rat-things-microvm-peer-$$"
network_name="rat-things-microvm-e2e-$$"
build_context="$(mktemp -d "${TMPDIR:-/tmp}/rat-things-microvm-e2e.XXXXXX")"

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
  docker rm --force "$peer_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  rm -r "$build_context"
}

trap cleanup EXIT
cd "$project_root"

npm run package
unzip -q dist/microvm-source.zip -d "$build_context"
docker buildx build \
  --platform linux/arm64 \
  --load \
  --tag "$image_tag" \
  "$build_context"

image_architecture="$(docker image inspect --format '{{.Architecture}}' "$image_tag")"
if [[ "$image_architecture" != "arm64" ]]; then
  echo "Expected an ARM64 image, found: $image_architecture" >&2
  exit 1
fi

docker network create "$network_name" >/dev/null
docker run \
  --detach \
  --name "$peer_name" \
  --network "$network_name" \
  --entrypoint node \
  "$image_tag" \
  --input-type=module \
  --eval '
    import { createServer } from "node:http";
    createServer((_request, response) => response.end("peer-ok"))
      .listen(8080, "0.0.0.0");
  ' >/dev/null

docker run \
  --detach \
  --name "$container_name" \
  --privileged \
  --cgroupns private \
  --network "$network_name" \
  --publish 127.0.0.1::8080 \
  "$image_tag" >/dev/null

published_port="$(docker port "$container_name" 8080/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
if [[ ! "$published_port" =~ ^[0-9]+$ ]]; then
  echo "Could not resolve the published lifecycle port." >&2
  exit 1
fi

ready=false
for _attempt in {1..30}; do
  if curl --fail --silent --show-error \
    --request POST \
    --header 'content-type: application/json' \
    --data '{}' \
    "http://127.0.0.1:${published_port}/aws/lambda-microvms/runtime/v1/ready" \
    >/dev/null 2>&1; then
    ready=true
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)" != "true" ]]; then
    docker logs "$container_name" >&2 || true
    echo "MicroVM image exited before it became ready." >&2
    exit 1
  fi
  sleep 1
done
if [[ "$ready" != "true" ]]; then
  docker logs "$container_name" >&2 || true
  echo "MicroVM image did not become ready." >&2
  exit 1
fi

docker exec \
  --user 10001 \
  --env "MICROVM_E2E_PEER=$peer_name" \
  "$container_name" \
  node --input-type=module --eval '
  import { networkInterfaces } from "node:os";

  const ownAddress = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  if (!ownAddress) throw new Error("could not resolve the container IPv4 address");

  for (const host of ["127.0.0.1", ownAddress]) {
    let blocked = false;
    try {
      await fetch(`http://${host}:8080/aws/lambda-microvms/runtime/v1/ready`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      blocked = true;
    }
    if (!blocked) throw new Error(`agent UID reached the lifecycle control plane at ${host}`);
  }

  const peer = await fetch(`http://${process.env.MICROVM_E2E_PEER}:8080`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!peer.ok || await peer.text() !== "peer-ok") {
    throw new Error("destination-scoped policy blocked an external port 8080 service");
  }
  process.stdout.write("agent UID control-plane access blocked; external port 8080 allowed\n");
'

docker exec --interactive --user 10001 \
  --env MICROVM_E2E_PRESERVE_BROWSER_ARTIFACTS=true \
  "$container_name" \
  node --input-type=module < "$script_dir/microvm-image-canary.mjs"

if command -v ffprobe >/dev/null 2>&1; then
  browser_artifacts="$build_context/browser-artifacts"
  mkdir -p "$browser_artifacts"
  docker cp \
    "$container_name:/tmp/rat-things-browser-artifacts/browser/navigation.webm" \
    "$browser_artifacts/navigation.webm"
  probe_output="$build_context/browser-webm-probe.txt"
  probe_errors="$build_context/browser-webm-errors.txt"
  if ! ffprobe \
    -v error \
    -select_streams v:0 \
    -show_entries stream=codec_name,width,height,r_frame_rate \
    -show_entries format=format_name,duration \
    -of default=noprint_wrappers=1 \
    "$browser_artifacts/navigation.webm" \
    >"$probe_output" 2>"$probe_errors"; then
    cat "$probe_errors" >&2
    echo "Browser recording failed strict ffprobe validation." >&2
    exit 1
  fi
  if [[ -s "$probe_errors" ]]; then
    cat "$probe_errors" >&2
    echo "Browser recording contains malformed WebM/EBML metadata." >&2
    exit 1
  fi
  if ! grep -Fxq 'codec_name=vp8' "$probe_output" || \
    ! grep -Fxq 'width=1280' "$probe_output" || \
    ! grep -Fxq 'height=720' "$probe_output" || \
    ! grep -Fxq 'r_frame_rate=5/1' "$probe_output"; then
    cat "$probe_output" >&2
    echo "Browser recording has unexpected stream metadata." >&2
    exit 1
  fi
  echo "Browser recording passed strict VP8 WebM/EBML validation."
fi

echo "ARM64 MicroVM lifecycle cgroup-BPF guard and Chromium canaries passed."

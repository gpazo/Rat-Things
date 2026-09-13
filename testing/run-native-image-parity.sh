#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
worker_image="${MICROVM_E2E_IMAGE_TAG:-rat-things-microvm-e2e:local}"
parity_image="${CODEX_PARITY_IMAGE_TAG:-rat-things-native-parity:local}"
cd "$project_root"
if [[ "$(docker image inspect --format '{{.Architecture}}' "$worker_image")" != arm64 ]]; then
  echo "Build the ARM64 worker with npm run test:e2e:microvm-image first." >&2
  exit 1
fi
docker buildx build --platform linux/arm64 --load \
  --file testing/native-parity.Dockerfile \
  --build-arg "WORKER_IMAGE=$worker_image" --tag "$parity_image" .
# Bubblewrap needs namespaces inside the outer disposable container. Tests and
# native child processes run as the same non-root UID used by the AWS worker.
# Fixture HTTP servers are local; no model credentials are forwarded.
docker run --rm --platform linux/arm64 --privileged --init "$parity_image"

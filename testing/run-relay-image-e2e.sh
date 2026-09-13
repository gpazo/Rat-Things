#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image_tag="${RELAY_E2E_IMAGE_TAG:-rat-things-relay-e2e:local}"
api_name="rat-things-api-e2e-$$"
relay_name="rat-things-relay-e2e-$$"
cleanup() {
  docker rm --force "$api_name" "$relay_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "$project_root"
npm run build
docker buildx build --platform linux/arm64 --load --file relay/Dockerfile --tag "$image_tag" .
[[ "$(docker image inspect --format '{{.Architecture}}' "$image_tag")" == arm64 ]]

# No network, host credentials or AWS endpoints are available to these boot probes.
common=(--detach --platform linux/arm64 --network none
  --env AWS_REGION=us-west-2 --env AWS_EC2_METADATA_DISABLED=true
  --env AWS_ACCESS_KEY_ID=test --env AWS_SECRET_ACCESS_KEY=test
  --env RUNS_TABLE_NAME=runs --env AGENTS_TABLE_NAME=agents
  --env ARTIFACT_BUCKET=artifacts --env DEFINITION_BUCKET=definitions
  --env RUN_QUEUE_URL=http://127.0.0.1:9/queue
  --env INTEGRATION_CREDENTIAL_NAME_PREFIX=test/ --env INTEGRATION_CREDENTIAL_KMS_KEY_ARN=test-key
  --env AGENTS_ENVIRONMENT_RELAY_URL=https://relay.example.invalid
  --env AGENTS_PUBLIC_BASE_URL=https://api.example.invalid/v1
  --env AGENTS_TOKEN_ISSUER_URL=https://issuer.lambda-url.us-west-2.on.aws/v1/auth/tokens)

docker run "${common[@]}" --read-only --name "$api_name" "$image_tag" node /app/agents-server.mjs >/dev/null
docker run "${common[@]}" --name "$relay_name" "$image_tag" >/dev/null
for container in "$api_name" "$relay_name"; do
  ready=false
  for _attempt in {1..30}; do
    if docker exec "$container" node --input-type=module --eval '
      const response = await fetch("http://127.0.0.1:8080/health", {signal: AbortSignal.timeout(1000)});
      if (!response.ok || (await response.json()).status !== "ok" || process.getuid() === 0) process.exit(1);
    ' >/dev/null 2>&1; then ready=true; break; fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]]; then break; fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then docker logs "$container" >&2; exit 1; fi
done

docker exec "$api_name" node --input-type=module --eval '
  const origin = "http://127.0.0.1:8080";
  const discovery = await (await fetch(`${origin}/.well-known/agents-api`)).json();
  if (discovery.base_url !== "https://api.example.invalid/v1" || !discovery.issuer_url.endsWith("/v1/auth/tokens")) throw Error("Invalid discovery");
  const denied = await fetch(`${origin}/v1/agents`);
  if (denied.status !== 401 || (await denied.json()).error.type !== "authentication_error") throw Error("Missing authentication guard");
  console.log("Read-only ARM64 API image: unprivileged health, discovery and authentication passed");
'
docker exec "$relay_name" codex --version
printf '%s\n' 'ARM64 relay image: unprivileged health and pinned protocol client passed'

# syntax=docker/dockerfile:1
ARG TARGETARCH
FROM public.ecr.aws/lambda/microvms:al2023-minimal@sha256:05cb9b38d841e7ff1b693dc9e894909612f340bf99ec97d426e8000a5bbe96c3 AS base-arm64
FROM public.ecr.aws/amazonlinux/amazonlinux:2023@sha256:c07ab0773eddf9449c0994a87d8148300db98bdf8d8dad672a9dc26321c104fc AS base-amd64
FROM base-${TARGETARCH} AS package
RUN dnf install -y nodejs22 nodejs22-npm && dnf clean all && rm -rf /var/cache/dnf
WORKDIR /rat
COPY runtime/codex /rat/runtime/codex
COPY package-lock.json /rat/package-lock.json
COPY scripts/build-codex-runtime.mjs scripts/codex-runtime-targets.mjs scripts/codex-runtime-artifact.mjs /rat/scripts/
RUN npm install --ignore-scripts --omit=dev --no-audit --no-fund --package-lock=false \
      "@openai/codex@$(node -p 'JSON.parse(require("fs").readFileSync("runtime/codex/source.json")).upstreamVersion')"
RUN node scripts/build-codex-runtime.mjs /out
FROM scratch AS artifact
COPY --from=package /out/ /

# syntax=docker/dockerfile:1
ARG TARGETARCH
FROM public.ecr.aws/lambda/microvms:al2023-minimal@sha256:05cb9b38d841e7ff1b693dc9e894909612f340bf99ec97d426e8000a5bbe96c3 AS base-arm64
FROM public.ecr.aws/amazonlinux/amazonlinux:2023@sha256:c07ab0773eddf9449c0994a87d8148300db98bdf8d8dad672a9dc26321c104fc AS base-amd64
# Both builders retain the worker's Amazon Linux 2023 glibc baseline.
FROM base-${TARGETARCH} AS build
ARG TARGETARCH
RUN dnf install -y gcc gcc-c++ make cmake clang pkgconfig libcap-devel perl-core \
      python3 git tar gzip xz unzip nodejs22 nodejs22-npm binutils findutils \
    && dnf clean all && rm -rf /var/cache/dnf
RUN dnf install -y openssl-devel && dnf clean all && rm -rf /var/cache/dnf
RUN curl --fail --location --silent --show-error https://sh.rustup.rs --output /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal --default-toolchain 1.95.0 --no-modify-path \
    && rm /tmp/rustup.sh
ENV PATH=/root/.cargo/bin:$PATH CARGO_BUILD_JOBS=1
WORKDIR /rat
COPY runtime/codex /rat/runtime/codex
COPY scripts/build-codex-runtime.mjs /rat/scripts/build-codex-runtime.mjs
COPY scripts/codex-runtime-targets.mjs /rat/scripts/codex-runtime-targets.mjs
RUN npm install --omit=dev --no-audit --no-fund \
      "@openai/codex@$(node -p 'JSON.parse(require("fs").readFileSync("runtime/codex/source.json")).upstreamVersion')"
RUN --mount=type=cache,target=/build,id=rat-codex-${TARGETARCH}-build \
    --mount=type=cache,target=/root/.cargo/registry,id=rat-codex-${TARGETARCH}-registry \
    --mount=type=cache,target=/root/.cargo/git,id=rat-codex-${TARGETARCH}-git \
    node scripts/build-codex-runtime.mjs /build \
    && mkdir /out && cp -a /build/runtime /out/runtime && cp /build/artifact.json /out/artifact.json
FROM scratch AS artifact
COPY --from=build /out/ /

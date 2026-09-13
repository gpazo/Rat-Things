# syntax=docker/dockerfile:1
# Build against the same glibc baseline as the isolated ARM64 worker image.
FROM public.ecr.aws/lambda/microvms:al2023-minimal@sha256:05cb9b38d841e7ff1b693dc9e894909612f340bf99ec97d426e8000a5bbe96c3 AS build
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
RUN npm install --omit=dev --no-audit --no-fund \
      "@openai/codex@$(node -p 'JSON.parse(require("fs").readFileSync("runtime/codex/source.json")).upstreamVersion')"
RUN --mount=type=cache,target=/build,id=rat-codex-arm64-build \
    --mount=type=cache,target=/root/.cargo/registry,id=rat-codex-arm64-registry \
    --mount=type=cache,target=/root/.cargo/git,id=rat-codex-arm64-git \
    test "$(uname -m)" = aarch64 \
    && node scripts/build-codex-runtime.mjs /build \
    && mkdir /out && cp -a /build/runtime /out/runtime && cp /build/artifact.json /out/artifact.json
FROM scratch AS artifact
COPY --from=build /out/ /

FROM public.ecr.aws/lambda/microvms:al2023-minimal AS network-policy-builder

RUN dnf install -y clang libbpf-devel \
    && dnf clean all \
    && rm -rf /var/cache/dnf

COPY runtime-network-policy.bpf.c /tmp/runtime-network-policy.bpf.c

RUN clang \
      -O2 \
      -g \
      -target bpf \
      -D__TARGET_ARCH_arm64 \
      -c /tmp/runtime-network-policy.bpf.c \
      -o /tmp/runtime-network-policy.bpf.o

FROM public.ecr.aws/lambda/microvms:al2023-minimal

ARG CODEX_VERSION=0.146.0
ARG PUPPETEER_CORE_VERSION=25.8.0
ARG CHROMIUM_VERSION=149.0.0
ARG WEBM_WRITER_VERSION=1.0.0
ARG CHROMIUM_ARM64_SHA256=9c42e7850d746cbf0ac0e68eaa48af277af8255a5ee12a813c08573671f231f6

RUN dnf install -y \
      bash \
      amazon-efs-utils \
      bpftool \
      ca-certificates \
      dejavu-sans-fonts \
      findutils \
      fontconfig \
      git \
      nspr \
      nss \
      nodejs22 \
      nodejs22-npm \
      openssh-clients \
      python3-botocore \
      shadow-utils \
      tar \
      util-linux \
    && dnf clean all \
    && rm -rf /var/cache/dnf \
    && install -d -m 0755 /opt/agent-runtime /opt/agent-runtime/bin /opt/agent-runtime/config /opt/chromium-pack /mnt/rat-things-state \
    && npm install --global \
      "@openai/codex@${CODEX_VERSION}" \
    && npm install --prefix /opt/agent-runtime --omit=dev --no-audit --no-fund \
      "@sparticuz/chromium-min@${CHROMIUM_VERSION}" \
      "puppeteer-core@${PUPPETEER_CORE_VERSION}" \
      "webm-writer@${WEBM_WRITER_VERSION}" \
    && npm cache clean --force \
    && curl --fail --location --silent --show-error \
      "https://github.com/Sparticuz/chromium/releases/download/v${CHROMIUM_VERSION}/chromium-v${CHROMIUM_VERSION}-pack.arm64.tar" \
      --output /tmp/chromium-pack.arm64.tar \
    && echo "${CHROMIUM_ARM64_SHA256}  /tmp/chromium-pack.arm64.tar" | sha256sum --check --strict \
    && tar --extract --file /tmp/chromium-pack.arm64.tar --directory /opt/chromium-pack --no-same-owner \
    && rm /tmp/chromium-pack.arm64.tar \
    && groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash agent \
    && install -d -o agent -g agent -m 0700 \
      /home/agent/.codex \
      /tmp/agent-runtime \
      /workspace

COPY runner.mjs /opt/agent-runtime/runner.mjs
COPY terminate-microvm.mjs /opt/agent-runtime/terminate-microvm.mjs
COPY runtime-server.mjs /opt/agent-runtime/runtime-server.mjs
COPY runtime-network-policy.mjs /opt/agent-runtime/runtime-network-policy.mjs
COPY --from=network-policy-builder /tmp/runtime-network-policy.bpf.o /opt/agent-runtime/runtime-network-policy.bpf.o
COPY runtime-process-policy.mjs /opt/agent-runtime/runtime-process-policy.mjs
COPY browser-host.mjs /opt/agent-runtime/browser-host.mjs
COPY bin/git-askpass.sh /opt/agent-runtime/bin/git-askpass.sh
COPY config/codex.toml /opt/agent-runtime/config/codex.toml
COPY config/codex.toml /home/agent/.codex/config.toml

RUN chown root:root \
      /opt/agent-runtime/runner.mjs \
      /opt/agent-runtime/terminate-microvm.mjs \
      /opt/agent-runtime/runtime-server.mjs \
      /opt/agent-runtime/runtime-network-policy.mjs \
      /opt/agent-runtime/runtime-network-policy.bpf.o \
      /opt/agent-runtime/runtime-process-policy.mjs \
      /opt/agent-runtime/browser-host.mjs \
      /opt/agent-runtime/bin/git-askpass.sh \
      /opt/agent-runtime/config/codex.toml \
    && chmod 0555 \
      /opt/agent-runtime/runner.mjs \
      /opt/agent-runtime/terminate-microvm.mjs \
      /opt/agent-runtime/runtime-server.mjs \
      /opt/agent-runtime/runtime-network-policy.mjs \
      /opt/agent-runtime/runtime-network-policy.bpf.o \
      /opt/agent-runtime/runtime-process-policy.mjs \
      /opt/agent-runtime/browser-host.mjs \
      /opt/agent-runtime/bin/git-askpass.sh \
    && chown -R agent:agent /home/agent/.codex /tmp/agent-runtime /workspace \
    && chmod 0444 /opt/agent-runtime/config/codex.toml /home/agent/.codex/config.toml

ENV NODE_ENV=production \
    AGENT_RUNNER_ENTRY=/opt/agent-runtime/runner.mjs \
    AGENT_TERMINATOR_ENTRY=/opt/agent-runtime/terminate-microvm.mjs \
    BROWSER_HOST_ENTRY=/opt/agent-runtime/browser-host.mjs \
    BROWSER_PROFILE_ROOT=/home/agent/.codex/browser-profile \
    CHROMIUM_PACK_DIR=/opt/chromium-pack \
    CODEX_CONFIG_TEMPLATE=/opt/agent-runtime/config/codex.toml \
    CODEX_HOME=/home/agent/.codex \
    GIT_ASKPASS_PATH=/opt/agent-runtime/bin/git-askpass.sh \
    HOME=/home/agent \
    RUN_AGENT_GID=10001 \
    RUN_AGENT_UID=10001 \
    S3_FILES_MOUNT_ROOT=/mnt/rat-things-state \
    WORKSPACE_ROOT=/tmp/agent-runtime

EXPOSE 8080
ENTRYPOINT ["node", "/opt/agent-runtime/runtime-server.mjs"]

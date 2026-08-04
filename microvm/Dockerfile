FROM public.ecr.aws/lambda/microvms:al2023-minimal

ARG CODEX_VERSION=0.146.0

RUN dnf install -y \
      bash \
      amazon-efs-utils \
      ca-certificates \
      findutils \
      git \
      nodejs22 \
      nodejs22-npm \
      openssh-clients \
      python3-botocore \
      shadow-utils \
      util-linux \
    && dnf clean all \
    && rm -rf /var/cache/dnf \
    && npm install --global \
      "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash agent \
    && install -d -m 0755 /opt/agent-runtime /opt/agent-runtime/bin /opt/agent-runtime/config /mnt/rat-things-state \
    && install -d -o agent -g agent -m 0700 \
      /home/agent/.codex \
      /tmp/agent-runtime \
      /workspace

COPY runner.mjs /opt/agent-runtime/runner.mjs
COPY terminate-microvm.mjs /opt/agent-runtime/terminate-microvm.mjs
COPY runtime-server.mjs /opt/agent-runtime/runtime-server.mjs
COPY bin/git-askpass.sh /opt/agent-runtime/bin/git-askpass.sh
COPY config/codex.toml /opt/agent-runtime/config/codex.toml
COPY config/codex.toml /home/agent/.codex/config.toml

RUN chown root:root \
      /opt/agent-runtime/runner.mjs \
      /opt/agent-runtime/terminate-microvm.mjs \
      /opt/agent-runtime/runtime-server.mjs \
      /opt/agent-runtime/bin/git-askpass.sh \
      /opt/agent-runtime/config/codex.toml \
    && chmod 0555 \
      /opt/agent-runtime/runner.mjs \
      /opt/agent-runtime/terminate-microvm.mjs \
      /opt/agent-runtime/runtime-server.mjs \
      /opt/agent-runtime/bin/git-askpass.sh \
    && chown -R agent:agent /home/agent/.codex /tmp/agent-runtime /workspace \
    && chmod 0444 /opt/agent-runtime/config/codex.toml /home/agent/.codex/config.toml

ENV NODE_ENV=production \
    AGENT_RUNNER_ENTRY=/opt/agent-runtime/runner.mjs \
    AGENT_TERMINATOR_ENTRY=/opt/agent-runtime/terminate-microvm.mjs \
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

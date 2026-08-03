FROM public.ecr.aws/docker/library/node:22-bookworm-slim

ARG CODEX_VERSION=0.146.0
ARG CLAUDE_CODE_VERSION=2.1.220

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates dumb-init git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force \
    && groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash agent \
    && install -d -o agent -g agent -m 0700 /workspace /tmp/agent-runtime /home/agent/.codex /app/bin

COPY --chown=root:root dist/runner.mjs /app/runner.mjs
COPY --chown=root:root config/codex.toml /home/agent/.codex/config.toml
COPY --chown=root:root scripts/git-askpass.sh /app/bin/git-askpass.sh

RUN chmod 0555 /app/runner.mjs /app/bin/git-askpass.sh \
    && chmod 0444 /home/agent/.codex/config.toml \
    && chown -R agent:agent /home/agent/.codex /workspace /tmp/agent-runtime

ENV NODE_ENV=production \
    HOME=/home/agent \
    CODEX_HOME=/home/agent/.codex \
    WORKSPACE_ROOT=/tmp/agent-runtime \
    GIT_ASKPASS_PATH=/app/bin/git-askpass.sh \
    RUN_AGENT_UID=10001 \
    RUN_AGENT_GID=10001

WORKDIR /workspace
ENTRYPOINT ["/usr/bin/dumb-init", "--", "node", "/app/runner.mjs"]

# syntax=docker/dockerfile:1
ARG WORKER_IMAGE=rat-things-microvm-e2e:local
FROM ${WORKER_IMAGE}
USER root
RUN install -d -o 10001 -g 10001 /rat
WORKDIR /rat
ENV NODE_ENV=test CODEX_CONFORMANCE_BINARY=/opt/codex-runtime/bin/codex CODEX_REQUIRE_PARITY=true
COPY --chown=10001:10001 package.json package-lock.json ./
USER 10001:10001
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force
COPY --chown=10001:10001 tsconfig.json ./
COPY --chown=10001:10001 src ./src
COPY --chown=10001:10001 tests ./tests
COPY --chown=10001:10001 spec ./spec
COPY --chown=10001:10001 runtime ./runtime
ENTRYPOINT ["npm", "run", "test:agents:parity"]

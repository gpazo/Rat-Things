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
COPY --chown=10001:10001 testing/fork-demo ./testing/fork-demo
COPY --chown=10001:10001 testing/local-runtime ./testing/local-runtime
COPY --chown=10001:10001 site/fork-demo/themes.js ./site/fork-demo/themes.js
ENTRYPOINT ["npm", "run", "test:agents:parity"]

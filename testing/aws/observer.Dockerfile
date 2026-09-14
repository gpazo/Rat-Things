FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
WORKDIR /observer
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json vitest.config.ts ./
COPY src/agents-client.ts ./src/agents-client.ts
COPY tests/aws/managed-session.test.ts ./tests/aws/managed-session.test.ts
COPY testing/aws/session-stream-monitor.ts ./testing/aws/session-stream-monitor.ts
RUN chown -R node:node /observer
USER node
ENTRYPOINT ["node", "node_modules/vitest/vitest.mjs", "run", "tests/aws/managed-session.test.ts", "--no-file-parallelism", "--reporter=verbose"]

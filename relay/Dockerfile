FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
# Native Codex uses OpenSSL, while Node carries its own public CA roots. Export
# the pinned image's roots so both HTTPS clients verify the same authorities.
RUN mkdir -p /etc/ssl/certs && node -e "require('node:fs').writeFileSync('/etc/ssl/certs/ca-certificates.crt', require('node:tls').rootCertificates.join('\n') + '\n')"
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
RUN npm install --global @openai/codex@0.154.0 && npm cache clean --force
WORKDIR /app
COPY dist/environment-relay.mjs /app/environment-relay.mjs
COPY dist/agents-server.mjs /app/agents-server.mjs
USER node
EXPOSE 8080
CMD ["node", "/app/environment-relay.mjs"]

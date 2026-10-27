FROM rat-things-local:1
# The local worker omits cloud orchestration; cold conformance uses its installed launch policy.
COPY --chown=0:0 --chmod=0555 runtime-process-policy.mjs /opt/agent-runtime/runtime-process-policy.mjs

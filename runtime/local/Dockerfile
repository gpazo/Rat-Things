FROM public.ecr.aws/amazonlinux/amazonlinux:2023@sha256:c07ab0773eddf9449c0994a87d8148300db98bdf8d8dad672a9dc26321c104fc AS worker-root
COPY package-inventory.py /opt/rat-build-tools/package-inventory.py
RUN python3 /opt/rat-build-tools/package-inventory.py snapshot /opt/rat-build-evidence/base-packages.json \
    && dnf --releasever=2023.12.20261016 --disablerepo='*' --enablerepo=amazonlinux --setopt=keepcache=True --setopt=gpgcheck=True install -y bash ca-certificates findutils git nodejs22 nodejs22-npm python3 python3-pip shadow-utils tar util-linux \
    && python3 /opt/rat-build-tools/package-inventory.py /opt/rat-build-evidence/worker --before /opt/rat-build-evidence/base-packages.json \
    && dnf clean all && rm -rf /var/cache/dnf \
    && groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash agent \
    && install -d -o agent -g agent -m 0700 /workspace /home/agent/.codex
COPY codex-runtime /opt/codex-runtime
COPY local-worker.mjs /opt/rat-things/local-worker.mjs
RUN find /opt/codex-runtime -type d -exec chmod 755 {} + \
    && chmod 644 /opt/rat-things/local-worker.mjs \
    && /opt/codex-runtime/bin/codex --version && ln -s /opt/codex-runtime/bin/codex /usr/local/bin/codex
WORKDIR /workspace
EXPOSE 3211
ENTRYPOINT ["node", "/opt/rat-things/local-worker.mjs"]

FROM worker-root AS native-root
COPY worker-notices /opt/rat-things/notices/javascript
RUN dnf --releasever=2023.12.20261016 --disablerepo='*' --enablerepo=amazonlinux --setopt=keepcache=True --setopt=gpgcheck=True install -y e2fsprogs kmod squashfs-tools \
    && python3 /opt/rat-build-tools/package-inventory.py /opt/rat-build-evidence/native --before /opt/rat-build-evidence/worker/inventory.json \
    && dnf clean all && rm -rf /var/cache/dnf
COPY modloop-virt /tmp/modloop-virt
COPY install-kernel-modules.py archive-root.py kernel-inputs.json /opt/rat-build-tools/
RUN python3 /opt/rat-build-tools/install-kernel-modules.py /tmp/modloop-virt \
    && rm -f /tmp/modloop-virt
COPY init.sh /init
COPY guest.py /opt/rat-things/native-guest.py
COPY export-workspace.cjs /opt/rat-things/export-workspace.cjs
RUN chmod 755 /init && chmod 644 /opt/rat-things/native-guest.py /opt/rat-things/export-workspace.cjs

FROM worker-root AS worker
RUN rm -rf /opt/rat-build-tools /opt/rat-build-evidence

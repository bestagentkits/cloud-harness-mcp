FROM oven/bun:1.2-slim AS bun-source
FROM ghcr.io/astral-sh/uv:latest AS uv-source

FROM node:24.11.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    patch \
    procps \
    ripgrep \
    sudo \
    tini \
    universal-ctags \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
COPY --from=uv-source /uv /uvx /usr/local/bin/

RUN npm install -g pnpm@latest wrangler@latest

# Pin the CLI separately from mounted skills. Checksums come from the release's
# https://releases.agentkit.best/binaries/2.18.0-beta.7/binary-update.json.
RUN set -eu; \
    version='2.18.0-beta.7'; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) checksum='bd724a56807fca9ce39a54b32a4964cf11a4026797fac53a5c105b74467343b9' ;; \
      arm64) checksum='7acfd1c591f91d845129983fd534840a9f064aeee997b5d34ee976f761bbeb0e' ;; \
      *) echo "Unsupported AgentKit CLI architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl --fail --show-error --silent --location \
      --retry 3 --retry-connrefused --retry-max-time 120 \
      --connect-timeout 15 --max-time 120 \
      "https://releases.agentkit.best/binaries/${version}/ak_${version}_linux_${arch}.tar.gz" \
      --output /tmp/ak.tar.gz; \
    printf '%s  %s\n' "$checksum" /tmp/ak.tar.gz | sha256sum --check --strict -; \
    mkdir /tmp/ak-extract; \
    tar -xzf /tmp/ak.tar.gz -C /tmp/ak-extract --no-same-owner --no-same-permissions ak LICENSE; \
    install -m 0555 /tmp/ak-extract/ak /usr/local/bin/ak; \
    install -D -m 0444 /tmp/ak-extract/LICENSE /usr/local/share/licenses/agentkit/LICENSE; \
    rm -rf /tmp/ak.tar.gz /tmp/ak-extract

RUN useradd --uid 10001 --create-home --shell /bin/bash harness \
  && echo "harness ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/harness \
  && chmod 0440 /etc/sudoers.d/harness

RUN echo 'export PATH="/opt/harness/bin:/workspace/node_modules/.bin:/opt/user-tools/bin:/opt/user-tools/pnpm/bin:/opt/user-tools/pnpm:/opt/user-tools/bun/bin:/tmp/cloud-harness-home/.local/bin:$PATH"' > /etc/profile.d/harness.sh \
  && chmod 0644 /etc/profile.d/harness.sh

RUN mkdir -p /workspace /opt/user-tools /var/cache/harness /tmp/cloud-harness-home \
  && chown -R 10001:10001 /workspace /opt/user-tools /var/cache/harness /tmp/cloud-harness-home

COPY --chown=root:root worker/harness-worker.mjs /opt/harness/harness-worker.mjs
COPY --chown=root:root worker/clone-helper.sh /opt/harness/clone-helper.sh
COPY --chown=root:root worker/git-transfer-helper.sh /opt/harness/git-transfer-helper.sh
COPY --chown=root:root worker/task-runner.sh /opt/harness/task-runner.sh
COPY --chown=root:root worker/shell-runner.sh /opt/harness/shell-runner.sh
COPY --chown=root:root worker/worker-runner.sh /opt/harness/worker-runner.sh
COPY --chown=root:root worker/gh-helper.sh /opt/harness/gh-helper.sh
COPY --chown=root:root worker/bin/npx-dispatcher /opt/harness/bin/npx
COPY --chown=root:root worker/bin/skills /opt/harness/bin/skills
COPY --chown=root:root worker/bin/skillx /opt/harness/bin/skillx
# /opt/harness is outside the repository, so nothing there would declare the extensionless launchers as
# ES modules. The dispatcher is installed as `npx` while the real npm entry point stays at
# /usr/local/bin/npx, which is why delegation cannot resolve back to this file. The launchers stay
# read-only to the unprivileged user that runs the workspace.
RUN chmod 0555 /opt/harness/*.sh /opt/harness/*.mjs \
  && printf '%s\n' '{"type":"module"}' > /opt/harness/package.json \
  && chmod 0644 /opt/harness/package.json \
  && chmod 0555 /opt/harness/bin/*

USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]

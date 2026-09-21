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

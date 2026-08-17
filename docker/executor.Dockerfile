FROM node:24.11.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git jq patch procps ripgrep tini universal-ctags \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --create-home --shell /bin/bash harness

COPY --chown=root:root worker/harness-worker.mjs /opt/harness/harness-worker.mjs
COPY --chown=root:root worker/clone-helper.sh /opt/harness/clone-helper.sh
COPY --chown=root:root worker/git-transfer-helper.sh /opt/harness/git-transfer-helper.sh
COPY --chown=root:root worker/task-runner.sh /opt/harness/task-runner.sh
COPY --chown=root:root worker/shell-runner.sh /opt/harness/shell-runner.sh
COPY --chown=root:root worker/worker-runner.sh /opt/harness/worker-runner.sh
RUN chmod 0555 /opt/harness/harness-worker.mjs /opt/harness/clone-helper.sh /opt/harness/git-transfer-helper.sh /opt/harness/task-runner.sh /opt/harness/shell-runner.sh /opt/harness/worker-runner.sh \
  && mkdir -p /workspace /tmp/cloud-harness-home \
  && chown -R 10001:10001 /workspace /tmp/cloud-harness-home

USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]

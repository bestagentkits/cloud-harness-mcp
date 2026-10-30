FROM node:24.11.0-alpine3.22 AS build
# The durable agent engine is opt-in. The default image leaves it, its dependencies, and the
# shared contracts it reads out entirely, so its size and contents match an image without it.
ARG INCLUDE_DURABLE_RUNTIME=false
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/runner/package.json apps/runner/tsconfig.json ./apps/runner/
COPY apps/agent-runtime/package.json apps/agent-runtime/tsconfig.json ./apps/agent-runtime/
COPY apps/agent-runtime-durable/package.json apps/agent-runtime-durable/tsconfig.json ./apps/agent-runtime-durable/
COPY apps/model-gateway/package.json apps/model-gateway/tsconfig.json ./apps/model-gateway/
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
RUN npm ci
COPY packages/contracts/src ./packages/contracts/src
COPY apps/agent-runtime/src ./apps/agent-runtime/src
COPY apps/agent-runtime-durable/src ./apps/agent-runtime-durable/src
COPY docker/drop-durable-runtime.mjs /tmp/drop-durable-runtime.mjs
# The default engine is compiled against the durable engine's types either way; it loads the
# engine only for a durable start record and fails that run clearly when the engine is absent.
RUN npm run build -w @cloud-harness/contracts \
  && npm run build -w @cloud-harness/agent-runtime-durable \
  && npm run build -w @cloud-harness/agent-runtime
# /optional holds what only the durable engine needs and stays empty in the default image. Without
# the engine, its workspace is dropped before pruning, so its dependencies leave the image too.
RUN set -eu; \
  mkdir -p /optional; \
  if [ "$INCLUDE_DURABLE_RUNTIME" = "true" ]; then \
    npm prune --omit=dev; \
    mkdir -p apps/agent-runtime-durable/node_modules /optional/apps/agent-runtime-durable /optional/packages/contracts; \
    cp -R apps/agent-runtime-durable/package.json apps/agent-runtime-durable/dist apps/agent-runtime-durable/node_modules /optional/apps/agent-runtime-durable/; \
    cp -R packages/contracts/package.json packages/contracts/dist /optional/packages/contracts/; \
    chmod 0444 /optional/apps/agent-runtime-durable/package.json /optional/packages/contracts/package.json; \
    chmod 0555 /optional/apps/agent-runtime-durable /optional/packages/contracts /optional/apps /optional/packages; \
  elif [ "$INCLUDE_DURABLE_RUNTIME" = "false" ]; then \
    node /tmp/drop-durable-runtime.mjs; \
    npm prune --omit=dev; \
  else \
    echo "INCLUDE_DURABLE_RUNTIME must be true or false" >&2; exit 1; \
  fi; \
  chmod 0555 /optional

FROM node:24.11.0-alpine3.22
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /app/apps/agent-runtime /runtime \
  && chown -R node:node /app \
  && chmod 0555 /app /app/apps /app/apps/agent-runtime /runtime
COPY --from=build --chown=node:node --chmod=0444 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node --chmod=0444 /app/apps/agent-runtime/package.json ./apps/agent-runtime/package.json
COPY --from=build --chown=node:node /app/apps/agent-runtime/dist ./apps/agent-runtime/dist
# Empty unless the image was built with INCLUDE_DURABLE_RUNTIME=true.
COPY --from=build --chown=node:node /optional/ ./
USER node
ENTRYPOINT ["/sbin/tini", "--", "node", "apps/agent-runtime/dist/index.js"]

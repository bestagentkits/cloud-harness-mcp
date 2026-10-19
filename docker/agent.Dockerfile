FROM node:24.11.0-alpine3.22 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/runner/package.json apps/runner/tsconfig.json ./apps/runner/
COPY apps/agent-runtime/package.json apps/agent-runtime/tsconfig.json ./apps/agent-runtime/
COPY apps/agent-runtime-durable/package.json apps/agent-runtime-durable/tsconfig.json ./apps/agent-runtime-durable/
COPY apps/model-gateway/package.json apps/model-gateway/tsconfig.json ./apps/model-gateway/
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
RUN npm ci
COPY apps/agent-runtime/src ./apps/agent-runtime/src
COPY apps/agent-runtime-durable/src ./apps/agent-runtime-durable/src
RUN npm run build -w @cloud-harness/agent-runtime-durable && npm run build -w @cloud-harness/agent-runtime && npm prune --omit=dev
# The durable engine keeps its own pi-ai release here, apart from the hoisted one the default
# engine uses; the directory exists even if npm ever hoists everything, so the copy below holds.
RUN mkdir -p apps/agent-runtime-durable/node_modules

FROM node:24.11.0-alpine3.22
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /app/apps/agent-runtime /app/apps/agent-runtime-durable /runtime \
  && chown -R node:node /app \
  && chmod 0555 /app /app/apps /app/apps/agent-runtime /app/apps/agent-runtime-durable /runtime
COPY --from=build --chown=node:node --chmod=0444 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node --chmod=0444 /app/apps/agent-runtime/package.json ./apps/agent-runtime/package.json
COPY --from=build --chown=node:node /app/apps/agent-runtime/dist ./apps/agent-runtime/dist
COPY --from=build --chown=node:node --chmod=0444 /app/apps/agent-runtime-durable/package.json ./apps/agent-runtime-durable/package.json
COPY --from=build --chown=node:node /app/apps/agent-runtime-durable/dist ./apps/agent-runtime-durable/dist
COPY --from=build --chown=node:node /app/apps/agent-runtime-durable/node_modules ./apps/agent-runtime-durable/node_modules
USER node
ENTRYPOINT ["/sbin/tini", "--", "node", "apps/agent-runtime/dist/index.js"]

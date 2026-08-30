FROM node:24.11.0-alpine3.22 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/runner/package.json apps/runner/tsconfig.json ./apps/runner/
COPY apps/agent-runtime/package.json apps/agent-runtime/tsconfig.json ./apps/agent-runtime/
COPY apps/model-gateway/package.json apps/model-gateway/tsconfig.json ./apps/model-gateway/
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
RUN npm ci
COPY apps/agent-runtime/src ./apps/agent-runtime/src
RUN npm run build -w @cloud-harness/agent-runtime && npm prune --omit=dev

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
USER node
ENTRYPOINT ["/sbin/tini", "--", "node", "apps/agent-runtime/dist/index.js"]

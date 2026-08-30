FROM node:24.11.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/runner/package.json apps/runner/tsconfig.json ./apps/runner/
COPY apps/agent-runtime/package.json apps/agent-runtime/tsconfig.json ./apps/agent-runtime/
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY apps/model-gateway/package.json apps/model-gateway/tsconfig.json ./apps/model-gateway/
RUN npm ci --ignore-scripts
COPY apps/model-gateway/src ./apps/model-gateway/src
RUN npm run build -w @cloud-harness/model-gateway

FROM node:24.11.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /app/apps/model-gateway/dist \
  && chown -R node:node /app \
  && chmod 0555 /app /app/apps /app/apps/model-gateway /app/apps/model-gateway/dist
COPY --from=build --chown=node:node --chmod=0444 /app/apps/model-gateway/package.json ./apps/model-gateway/package.json
COPY --from=build --chown=node:node --chmod=0555 /app/apps/model-gateway/dist ./apps/model-gateway/dist
USER node
EXPOSE 3210
CMD ["node", "apps/model-gateway/dist/index.js"]

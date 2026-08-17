FROM node:24.11.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/runner/package.json apps/runner/tsconfig.json ./apps/runner/
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
RUN npm ci
COPY apps/api/src ./apps/api/src
COPY packages/contracts/src ./packages/contracts/src
RUN npm run build -w @cloud-harness/contracts && npm run build -w @cloud-harness/api && npm prune --omit=dev

FROM node:24.11.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /app/apps/api /app/packages/contracts \
  && chmod 0755 /app/apps /app/apps/api /app/packages /app/packages/contracts
COPY --from=build --chmod=0444 /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build --chmod=0444 /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build --chmod=0444 /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --chown=node:node --chmod=0555 scripts/deploy-canary.mjs ./scripts/deploy-canary.mjs
COPY --chown=node:node --chmod=0555 deploy/ingress-proxy.mjs ./deploy/ingress-proxy.mjs
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]

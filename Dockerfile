FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY apps/gateway/package.json apps/gateway/
COPY apps/agent/package.json apps/agent/
COPY apps/console/package.json apps/console/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @leash/console build
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "--import", "tsx", "apps/gateway/src/main.ts"]

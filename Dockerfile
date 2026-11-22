# syntax=docker/dockerfile:1

# Production dependencies only. Lifecycle scripts are skipped: no runtime dependency needs one.
FROM oven/bun:1.4.5-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# Bun runs the TypeScript sources directly, so there is no build step. tsconfig.json is needed
# at runtime: Bun reads emitDecoratorMetadata from it, and NestJS dependency injection relies
# on that metadata.
FROM oven/bun:1.4.5-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]

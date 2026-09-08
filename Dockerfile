ARG NODE_IMAGE=node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN npm install --global pnpm@11.15.1
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @servitas/worker deploy --prod --legacy /worker-runtime

FROM ${NODE_IMAGE} AS web
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build /app/apps/web/.output ./
EXPOSE 3000
CMD ["node", "server/index.mjs"]

FROM ${NODE_IMAGE} AS worker
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/apps/worker/dist ./dist
COPY --from=build /worker-runtime/node_modules ./node_modules
COPY --from=build /app/apps/worker/package.json ./package.json
CMD ["node", "dist/index.js"]

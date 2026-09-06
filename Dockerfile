FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.15.1
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build /app/apps/web/.output ./
EXPOSE 3000
CMD ["node", "server/index.mjs"]

FROM node:24-bookworm-slim AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/worker/dist ./dist
CMD ["node", "dist/index.js"]

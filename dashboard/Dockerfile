# syntax=docker/dockerfile:1
# Wasabi dashboard — self-hosted Next.js (standalone) + node:sqlite store.
# Build:  docker compose build   (from ../deploy)
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    WASABI_DB=/app/.data/wasabi.db
# non-root + a writable home for the SQLite store (mounted as a volume)
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 \
 && mkdir -p /app/.data && chown -R nextjs:nodejs /app
# Next standalone server + static assets only (slim image)
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
VOLUME ["/app/.data"]
# node:sqlite is built into Node 24 (experimental, no flag needed). If your Node
# build still gates it, add NODE_OPTIONS=--experimental-sqlite in compose.
CMD ["node", "server.js"]

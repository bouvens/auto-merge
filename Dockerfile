# ---- builder ----
# Alpine keeps the build image small; all dev deps (tsx, vitest, biome) stay here and never reach runtime.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc --project tsconfig.build.json

# ---- runtime ----
FROM node:22-alpine AS runtime

# tini is baked into the image rather than relying on `docker run --init` because
# k8s does not forward the Docker --init flag — without tini, node becomes PID 1
# and cannot reap zombie child processes spawned by Probot/native modules (OPS-02).
RUN apk add --no-cache tini

WORKDIR /app
COPY package.json package-lock.json ./

# --omit=dev excludes tsx, vitest, biome, msw, pino-pretty, smee-client — none are
# needed at runtime, keeping the image lean and the attack surface smaller.
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Run as the built-in non-root node user (uid 1000) so a container escape does not
# grant root on the host (T-07-02 / OPS-01).
USER node

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/index.js"]

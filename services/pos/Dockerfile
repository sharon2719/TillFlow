# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT, not this directory — npm workspaces resolve against the
# root package-lock.json. Build from the repo root:
#   docker build -f services/pos/Dockerfile -t tillflow-pos:local .

FROM node:22.11.0-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY services/pos/package.json services/pos/package.json
COPY services/web/package.json services/web/package.json
COPY services/payments/package.json services/payments/package.json
COPY services/commission/package.json services/commission/package.json
COPY services/_shared/package.json services/_shared/package.json
RUN npm ci

FROM deps AS build
COPY services/pos ./services/pos
RUN npm run build --workspace=@tillflow/pos

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/services/pos/dist ./services/pos/dist
COPY services/pos/package.json services/pos/package.json
# migrate.js resolves this directory relative to itself at runtime (services/pos/src/migrate.ts)
COPY services/pos/migrations ./services/pos/migrations

RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "services/pos/dist/index.js"]

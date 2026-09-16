# syntax=docker/dockerfile:1
# Build from the repository root so npm workspaces resolve the root lockfile.
#   docker build -f services/payments/Dockerfile -t tillflow-payments:local .

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
# _shared's full source is needed here (not just its package.json) - payments' own build
# script chains "build --workspace=@tillflow/shared" first, since payments imports it.
COPY services/_shared ./services/_shared
COPY services/payments ./services/payments
RUN npm run build --workspace=@tillflow/payments

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/services/payments/dist ./services/payments/dist
COPY services/payments/package.json services/payments/package.json
COPY services/payments/migrations ./services/payments/migrations
# The npm workspace symlink node_modules/@tillflow/shared points to ../../services/_shared -
# that relative target has to actually exist in this stage too, package.json + dist both,
# or requiring "@tillflow/shared" at runtime resolves to nothing.
COPY --from=build /app/services/_shared/dist ./services/_shared/dist
COPY services/_shared/package.json services/_shared/package.json

RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "services/payments/dist/index.js"]

# syntax=docker/dockerfile:1
# Build from the repository root so npm workspaces resolve the root lockfile.
#   docker build -f services/commission/Dockerfile -t tillflow-commission:local .

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
COPY services/commission ./services/commission
RUN npm run build --workspace=@tillflow/commission

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/services/commission/dist ./services/commission/dist
COPY services/commission/package.json services/commission/package.json
COPY services/commission/migrations ./services/commission/migrations

RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:3002/health || exit 1

CMD ["node", "services/commission/dist/index.js"]

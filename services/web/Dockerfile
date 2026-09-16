# syntax=docker/dockerfile:1
# Build from the repository root so npm workspaces resolve the root lockfile.
#   docker build -f services/web/Dockerfile -t tillflow-web:local .

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
COPY services/web ./services/web
RUN npm run build --workspace=@tillflow/web

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/services/web/dist ./services/web/dist
COPY services/web/package.json services/web/package.json

RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:3003/health || exit 1

CMD ["node", "services/web/dist/index.js"]

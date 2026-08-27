# Backend image (API + ingestion cron). Build context is the REPO ROOT, so
# COPY paths are prefixed with backend/. Railway is pointed here via
# railway.json / railway.cron.json (build.dockerfilePath = backend/Dockerfile).
FROM node:20-slim

# OpenSSL is required by Prisma's query engine.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. Copy the Prisma schema before `npm ci`
# so the postinstall `prisma generate` has it.
COPY backend/package.json backend/package-lock.json ./
COPY backend/prisma ./prisma
RUN npm ci

# Build the TypeScript sources.
COPY backend/ ./
RUN npm run build

ENV NODE_ENV=production

# Default command = API: apply migrations, then serve. The cron service
# overrides this via railway.cron.json's startCommand.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/api/server.js"]

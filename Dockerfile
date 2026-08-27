# Single-service image: builds the Express API and the Next.js app, and runs
# both in one container. Next.js serves the UI on $PORT and proxies /api/* to
# the API on 127.0.0.1:4000. Build context is the repo root.
FROM node:20-slim

# OpenSSL is required by Prisma's query engine.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Backend deps + build ---
# Copy the Prisma schema before `npm ci` so its postinstall `prisma generate` works.
COPY backend/package.json backend/package-lock.json ./backend/
COPY backend/prisma ./backend/prisma
RUN cd backend && npm ci
COPY backend/ ./backend/
RUN cd backend && npm run build

# --- Frontend deps + build ---
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

ENV NODE_ENV=production
COPY start.sh ./start.sh

# Next.js listens on $PORT (Railway injects it); the API is internal on 4000.
CMD ["sh", "start.sh"]

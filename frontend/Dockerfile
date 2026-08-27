# Frontend image (Next.js). Build context is the REPO ROOT, so COPY paths are
# prefixed with frontend/. Railway is pointed here via railway.web.json
# (build.dockerfilePath = frontend/Dockerfile).
FROM node:20-slim

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./

# NEXT_PUBLIC_* is inlined at build time. Railway passes service variables as
# build args; declare it so the API URL is baked into the client bundle.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# `next start` reads PORT (Railway injects it); package.json start honors it.
CMD ["npm", "run", "start"]

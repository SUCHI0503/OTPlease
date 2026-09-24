# API server, worker and the migration job all run from this one image (the command decides which).
FROM node:24-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
RUN npm ci -w server -w worker --include-workspace-root
COPY scripts/build.mjs scripts/
COPY apps/server apps/server
COPY apps/worker apps/worker
RUN npx prisma generate --schema apps/server/prisma/schema.prisma && node scripts/build.mjs

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
RUN npm ci -w server -w worker --omit=dev --ignore-scripts && npm cache clean --force
COPY apps/server/prisma apps/server/prisma
RUN npx prisma generate --schema apps/server/prisma/schema.prisma
COPY --from=build /repo/apps/server/dist apps/server/dist
COPY --from=build /repo/apps/worker/dist apps/worker/dist
USER node
EXPOSE 4000
CMD ["node", "apps/server/dist/index.js"]
